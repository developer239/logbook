import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LogBookError, openSqlite, type ISqliteDb } from '@log-book/core'
import type { IImportedSession, IMessageRecord } from '@log-book/warehouse'
import { describe, expect, it } from 'vitest'
import type { IHarnessAdapter, IImportedUnit, ISourceUnit } from '../contract.js'
import { ADAPTER_ERROR_CODES, childIdOf, sessionIdOf, timeSpan } from '../helpers.js'
import { conformanceCases, type IFixtureSet } from './index.js'

// A minimal correct adapter for an invented harness that keeps its sessions in one SQLite file.
const DATABASE_ID = 'minimal-database'
const FIXTURE_ROOT = fileURLToPath(new URL('fixtures/sqlite-1.0', import.meta.url))
const SCHEMA =
  'CREATE TABLE entry (session TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)'
const ROWS = [
  "INSERT INTO entry VALUES ('alpha', 0, 'user', 'add a discount code field', 1000)",
  "INSERT INTO entry VALUES ('alpha', 1, 'assistant', 'Added the field.', 2000)",
  "INSERT INTO entry VALUES ('beta', 0, 'user', 'fix rounding in invoice totals', 5000)",
  // The row a running harness has written since the last checkpoint.
  "INSERT INTO entry VALUES ('beta', 1, 'assistant', 'Rounded half up.', 6000)",
]
const LIVE_CASES = new Set(['1.0: golden output', '1.0: read-only on a live database'])

interface IEntryRow {
  seq: number
  role: 'user' | 'assistant'
  text: string
  at: number
}

const databasePath = (home: string): string => join(home, '.minidb', 'data.db')

const messageRecord = (sessionId: string, row: IEntryRow): IMessageRecord => ({
  id: childIdOf(sessionId, `m${String(row.seq)}`),
  sessionId,
  seq: row.seq,
  actor: row.role,
  sourceRole: row.role,
  createdAt: row.at,
  completedAt: null,
  requestedAt: null,
  model: null,
  agent: null,
  gitBranch: null,
  tokensInput: null,
  tokensOutput: null,
  tokensReasoning: null,
  tokensCacheRead: null,
  tokensCacheWrite: null,
  reportedCost: null,
})

const importSession = (db: ISqliteDb, unit: ISourceUnit): IImportedUnit => {
  const rows = db
    .prepare('SELECT seq, role, text, at FROM entry WHERE session = ? ORDER BY seq')
    .all(unit.locator) as IEntryRow[]
  if (rows.length === 0) {
    throw new LogBookError(`The session ${unit.locator} is gone.`, ADAPTER_ERROR_CODES.ADAPTER_UNIT_GONE)
  }
  const sessionId = sessionIdOf(DATABASE_ID, unit.locator)
  const messages = rows.map((row) => messageRecord(sessionId, row))
  const session: IImportedSession = {
    session: {
      id: sessionId,
      harness: DATABASE_ID,
      sourceId: unit.locator,
      origin: 'interactive',
      isScripted: false,
      projectDir: null,
      title: null,
      agent: null,
      spawnedBySessionId: null,
      spawnedByToolCallId: null,
      ...timeSpan(messages),
    },
    messages,
    parts: rows.map((row, index) => ({
      messageId: messages[index]?.id ?? '',
      sessionId,
      idx: 0,
      kind: 'text',
      text: row.text,
      toolCallId: null,
    })),
    toolCalls: [],
    events: [],
  }
  return { sessions: [session], harnessVersion: null }
}

const databaseAdapter: IHarnessAdapter = {
  descriptor: {
    id: DATABASE_ID,
    name: 'Minimal Database',
    defaultAgent: 'main',
    unitNoun: 'sessions',
    filterAlias: 'minidb',
    parserVersion: 1,
    testedVersions: ['1.0'],
    locationVariables: [],
  },
  locate: async (env) => {
    const root = databasePath(env.homeDir)
    const isFile = await stat(root).then(
      (found) => found.isFile(),
      () => false
    )
    return isFile
      ? { kind: 'found', location: { root, kind: 'file', describe: '~/.minidb/data.db' } }
      : { kind: 'not-found', lookedAt: root }
  },
  openSource: async (location, context) => {
    const db = await context.openSqlite(location.root, { isReadOnly: true })
    return {
      formatDrift: null,
      listUnits: async () =>
        Promise.resolve(
          (
            db
              .prepare(
                'SELECT session, count(*) AS entries, max(at) AS last FROM entry GROUP BY session ORDER BY session'
              )
              .all() as { session: string; entries: number; last: number }[]
          ).map((row) => ({ locator: row.session, fingerprint: `${String(row.entries)}:${String(row.last)}` }))
        ),
      importUnit: async (unit) => Promise.resolve(importSession(db, unit)),
      close: async () => {
        db.close()
        await Promise.resolve()
      },
    }
  },
  prepareCommands: async () => Promise.resolve({ recognise: () => null }),
}

const writeDatabase = async (home: string): Promise<ISqliteDb> => {
  await mkdir(join(home, '.minidb'), { recursive: true })
  return openSqlite(databasePath(home), { isReadOnly: false })
}

// Only the golden-output and live-database cases run on this set; the rest are the JSON-lines adapter's.
const notUsed = async (): Promise<void> => {
  await Promise.reject(new Error('Not used by the live database set'))
}

const databaseFixture: IFixtureSet = {
  harnessVersion: '1.0',
  root: FIXTURE_ROOT,
  locationKind: 'file',
  units: [
    { locator: 'alpha', harnessVersion: null, unknownRecords: [] },
    { locator: 'beta', harnessVersion: null, unknownRecords: [] },
  ],
  environment: (home) => ({ variables: {}, homeDir: home, cwd: home, platform: 'linux' }),
  // A fixture database in journal mode DELETE, as committed sets keep theirs.
  prepare: async (home) => {
    const db = await writeDatabase(home)
    db.exec([SCHEMA, ...ROWS].join(';\n'))
    db.close()
  },
  // As a running harness leaves it: write-ahead log on, no automatic checkpoint, the last row only in the `-wal`, and
  // the writer still open.
  prepareLive: async (home) => {
    const db = await writeDatabase(home)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA wal_autocheckpoint = 0')
    db.exec([SCHEMA, ...ROWS.slice(0, -1)].join(';\n'))
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.exec(ROWS.at(-1) ?? '')
    return () => {
      db.close()
    }
  },
  change: notUsed,
  remove: async (home) => {
    await rm(databasePath(home))
  },
  locateVariants: [],
  neverRead: [],
}

describe('conformanceCases for a minimal adapter over a live SQLite file', () => {
  it.each(
    conformanceCases(databaseAdapter, [databaseFixture])
      .filter((testCase) => LIVE_CASES.has(testCase.name))
      .map((testCase) => [testCase.name, testCase])
  )('%s', async (_name, testCase) => {
    // Act
    const run = testCase.run()

    // Assert
    await expect(run).resolves.toBeUndefined()
  })
})
