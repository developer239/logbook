import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ADAPTER_ERROR_CODES,
  type IAdapterContext,
  type IHarnessLocation,
  type ISourceReader,
} from '@log-book/adapter-api'
import { openSqlite } from '@log-book/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NEWEST_TESTED_MIGRATION, openDatabase } from './database.js'

const SCHEMA = `
CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, agent TEXT, version TEXT,
  time_created INTEGER, time_updated INTEGER);
CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER,
  time_updated INTEGER, data TEXT);
`
const SESSIONS = `
INSERT INTO session_v2 (id, parent_id, directory, title, agent, version, time_created, time_updated) VALUES ('ses_example01', NULL, '/home/example/work/shop', 'Coupons', 'build', '2.0.21', 1000, 5000);
INSERT INTO session_v2 (id, parent_id, directory, title, agent, version, time_created, time_updated) VALUES ('ses_example02', NULL, '/home/example/work/billing', NULL, 'build', '2.0.21', 2000, 2000);
INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('msg_example01', 'ses_example01', 'user', 1, 1000, 1000, '{}');
INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('msg_example02', 'ses_example01', 'assistant', 2, 1100, 1300, '{}');
`

interface IRecordingContext extends IAdapterContext {
  closes: () => number
}

// The context's openSqlite, recording every close of a handle it opened.
const recordingContext = (signal = new AbortController().signal): IRecordingContext => {
  let closes = 0
  return {
    signal,
    onProgress: () => undefined,
    openSqlite: async (path, options) => {
      const db = await openSqlite(path, options)
      return {
        ...db,
        close: () => {
          closes += 1
          db.close()
        },
      }
    },
    closes: () => closes,
  }
}

const codeOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => 'opened',
    (error: unknown) =>
      error instanceof Error && 'code' in error ? { code: error.code, message: error.message } : String(error)
  )

describe('openDatabase', () => {
  let directory = ''
  let location: IHarnessLocation = { root: '', kind: 'file', describe: '' }

  const build = async (sql: string): Promise<void> => {
    const db = await openSqlite(location.root, { isReadOnly: false })
    db.exec(sql)
    db.close()
  }

  const open = async (context: IAdapterContext = recordingContext()): Promise<ISourceReader> =>
    openDatabase(location, context)

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-opencode-db-')))
    location = { root: join(directory, 'opencode.db'), kind: 'file', describe: '~/.local/share/opencode/opencode.db' }
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('refuses a database missing session_message.data, naming it, and closes the handle', async () => {
    // Arrange
    await build(SCHEMA.replace(', data TEXT', ''))
    const context = recordingContext()

    // Act
    const outcome = await codeOf(open(context))

    // Assert
    expect({ outcome, closes: context.closes() }).toStrictEqual({
      outcome: {
        code: ADAPTER_ERROR_CODES.ADAPTER_FORMAT_UNSUPPORTED,
        message: 'the database has no column session_message.data',
      },
      closes: 1,
    })
  })

  it('refuses an OpenCode 1.x database with the migration hint', async () => {
    // Arrange
    await build('CREATE TABLE session (id TEXT PRIMARY KEY, data TEXT);')

    // Act
    const outcome = await codeOf(open())

    // Assert
    expect(outcome).toStrictEqual({
      code: ADAPTER_ERROR_CODES.ADAPTER_FORMAT_UNSUPPORTED,
      message: 'OpenCode 1.x database; start OpenCode 2 once to migrate it',
    })
  })

  it('refuses a text file as unreadable, naming its path, and closes the handle', async () => {
    // Arrange
    await writeFile(location.root, 'this is not a database, only invented text long enough to fill a header page\n')
    const context = recordingContext()

    // Act
    const outcome = (await codeOf(open(context))) as { code: string; message: string }

    // Assert
    expect({
      code: outcome.code,
      isNamed: outcome.message.includes(location.root),
      closes: context.closes(),
    }).toStrictEqual({
      code: ADAPTER_ERROR_CODES.ADAPTER_SOURCE_UNREADABLE,
      isNamed: true,
      closes: 1,
    })
  })

  it('ignores extra tables and columns, and lists each session with its fingerprint', async () => {
    // Arrange
    await build(`${SCHEMA.replace('time_updated INTEGER);', 'time_updated INTEGER, share_url TEXT);')}
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);${SESSIONS}`)
    const reader = await open()

    // Act
    const units = await reader.listUnits()
    await reader.close()

    // Assert
    expect({ units, drift: reader.formatDrift }).toStrictEqual({
      units: [
        { locator: 'ses_example01', fingerprint: '5000:2:1300' },
        { locator: 'ses_example02', fingerprint: '2000:0:0' },
      ],
      drift: null,
    })
  })

  it.each([
    [
      'a message edited in place',
      "UPDATE session_message SET time_updated = 1400 WHERE id = 'msg_example02'",
      '5000:2:1400',
    ],
    ['a deleted message', "DELETE FROM session_message WHERE id = 'msg_example02'", '5000:1:1000'],
  ])('changes the fingerprint after %s', async (_change, sql, fingerprint) => {
    // Arrange
    await build(`${SCHEMA}${SESSIONS}`)
    await build(sql)
    const reader = await open()

    // Act
    const [unit] = await reader.listUnits()
    await reader.close()

    // Assert
    expect(unit).toStrictEqual({ locator: 'ses_example01', fingerprint })
  })

  it('closes without throwing after a listing aborted through the signal', async () => {
    // Arrange
    await build(`${SCHEMA}${SESSIONS}`)
    const controller = new AbortController()
    const context = recordingContext(controller.signal)
    const reader = await open(context)
    controller.abort(new Error('stopped'))

    // Act
    const listing = await codeOf(reader.listUnits())
    await reader.close()

    // Assert
    expect({ listing, closes: context.closes() }).toStrictEqual({ listing: 'Error: stopped', closes: 1 })
  })

  it.each<[string, string, unknown]>([
    ['no migration table', '', null],
    [
      'the newest tested migration, with older ones before it',
      `CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
       INSERT INTO migration VALUES ('20260101000000_first', 1), ('${NEWEST_TESTED_MIGRATION}', 2);`,
      null,
    ],
    [
      'a newer migration beside the tested one',
      `CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
       INSERT INTO migration VALUES ('${NEWEST_TESTED_MIGRATION}', 1), ('20261001120000_example_change', 2);`,
      { seen: '20261001120000_example_change', testedUpTo: '20260923013825_project_time_active' },
    ],
    [
      'a newest migration id not in the timestamp form',
      `CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
       INSERT INTO migration VALUES ('${NEWEST_TESTED_MIGRATION}', 1), ('zz_unplaceable', 2);`,
      { seen: 'zz_unplaceable', testedUpTo: '20260923013825_project_time_active' },
    ],
  ])('sets the format drift for %s, and still lists every session', async (_case, migrations, drift) => {
    // Arrange
    await build(`${SCHEMA}${SESSIONS}${migrations}`)
    const reader = await open()

    // Act
    const units = await reader.listUnits()
    await reader.close()

    // Assert
    expect({ drift: reader.formatDrift, locators: units.map((unit) => unit.locator) }).toStrictEqual({
      drift,
      locators: ['ses_example01', 'ses_example02'],
    })
  })
})
