import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inventedAdapter } from '@log-book/adapter-api/testing'
import { openSqlite } from '@log-book/core'
import {
  readLabelsLock,
  readSyncLock,
  takeLabelsLock,
  takeSyncLock,
  WAREHOUSE_ERROR_CODES,
  WarehouseLockHeldError,
  type IHeldLock,
} from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runSync } from '../sync/sync.js'
import { typeScriptChildArgs } from '../testing/index.js'
import { runForget, type ForgetTarget, type IForgetSessionsResult } from './forget.js'

const CHILD_TIMEOUT_MS = 20_000
const MAIN = 'test-harness:main'
const CHILD = 'test-harness:child'
const KEPT = 'test-harness:kept'
const PHRASE = 'walrus-coloured umbrella'
// The sessions the invented adapter's sync imported, beside the ones the test inserts.
const SYNCED = `id NOT IN ('test-harness:main', 'test-harness:child', 'test-harness:kept')`
// The tables that hold a session's rows, with the column naming it.
const SESSION_COLUMNS: readonly (readonly [string, string])[] = [
  ['session', 'id'],
  ['message', 'session_id'],
  ['part', 'session_id'],
  ['tool_call', 'session_id'],
  ['event', 'session_id'],
  ['turn', 'session_id'],
  ['session_command', 'session_id'],
  ['link', 'child_session_id'],
]

// Runs a forget of the sessions it is given, and prints its result.
const FORGETTING_CHILD = `const [forgetUrl, warehousePath, ...sessions] = process.argv.slice(2)
const { runForget } = await import(forgetUrl)
const result = await runForget({ warehousePath, target: { sessions }, signal: new AbortController().signal, onProgress: () => {} })
process.stdout.write(JSON.stringify(result))
`

type TRow = Record<string, string | number | null>

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

const bytesOf = (path: string): number =>
  statSync(path).size + (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0)

// A session with a prompt holding the text, a call and a label on the prompt.
const sessionRows = (id: string, text: string): [string, TRow][] => [
  [
    'session',
    {
      id,
      harness: 'test-harness',
      source_id: id.slice(13),
      origin: 'interactive',
      is_scripted: 0,
      project_dir: `/home/example/work/${id.slice(13)}`,
      started_at: 1,
      ended_at: 2,
    },
  ],
  ['message', { id: `${id}/m0`, session_id: id, seq: 0, actor: 'user', source_role: 'user', created_at: 1 }],
  ['part', { message_id: `${id}/m0`, session_id: id, idx: 0, kind: 'text', text }],
  [
    'tool_call',
    {
      id: `${id}/c0`,
      session_id: id,
      message_id: `${id}/m0`,
      name: 'Read',
      bare_name: 'Read',
      family: 'read',
      input_json: '{}',
      status: 'ok',
    },
  ],
  [
    'label',
    {
      record_type: 'message',
      record_id: `${id}/m0`,
      labeller: 'model-a',
      version: 1,
      name: 'act',
      value: 'task',
      labelled_at: 1,
    },
  ],
]

describe('runForget', () => {
  let home = ''
  let warehouse: ITestWarehouse | null = null
  let held: IHeldLock[] = []

  const opened = (): ITestWarehouse => {
    if (warehouse === null) {
      throw new Error('The warehouse is not open.')
    }
    return warehouse
  }

  const forget = async (target: ForgetTarget): Promise<IForgetSessionsResult> =>
    runForget({
      warehousePath: opened().path,
      target,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    })

  const count = async (sql: string, ...params: string[]): Promise<number> => {
    const db = await openSqlite(opened().path, { isReadOnly: true })
    try {
      return (db.prepare(sql).get(...params) as { count: number }).count
    } finally {
      db.close()
    }
  }

  // Each session's rows in every table that holds them, and its labels.
  const rowsOf = async (id: string): Promise<Record<string, number>> =>
    Object.fromEntries([
      ...(await Promise.all(
        SESSION_COLUMNS.map(
          async ([table, column]) =>
            [table, await count(`SELECT count(*) AS count FROM ${table} WHERE ${column} = ?`, id)] as const
        )
      )),
      [
        'label',
        await count("SELECT count(*) AS count FROM label WHERE record_id = ? OR record_id LIKE ? || '/%'", id, id),
      ],
      ['forgotten', await count('SELECT count(*) AS count FROM forgotten WHERE session_id = ?', id)],
    ])

  const arrange = (rows: readonly [string, TRow][]): void => {
    for (const [table, row] of rows) {
      insert(opened().db, table, row)
    }
  }

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'log-book-forget-home-')))
    vi.stubEnv('HOME', home)
    await writeFile(join(home, 'child.mjs'), FORGETTING_CHILD)
    warehouse = await createTestWarehouse()
    warehouse.db.exec('PRAGMA journal_mode = WAL')
    arrange([
      ...sessionRows(MAIN, `keep the saved cart, the ${PHRASE}`),
      ...sessionRows(CHILD, 'look up the cart total'),
      ...sessionRows(KEPT, 'fix the invoice rounding'),
      [
        'link',
        {
          parent_session_id: MAIN,
          parent_tool_call_id: `${MAIN}/c0`,
          child_session_id: CHILD,
          kind: 'subagent',
          confidence: 'exact',
          evidence: 'reported',
        },
      ],
    ])
  })

  afterEach(async () => {
    for (const lock of held) {
      lock.release()
    }
    held = []
    vi.unstubAllEnvs()
    await warehouse?.remove()
    warehouse = null
    await rm(home, { recursive: true, force: true })
  })

  it('forgets a session and its subagent child from every table but forgotten, counting the labels', async () => {
    // Arrange
    const progress: unknown[] = []
    const bytesBefore = bytesOf(opened().path)

    // Act
    const result = await runForget({
      warehousePath: opened().path,
      target: { sessions: ['main'] },
      signal: new AbortController().signal,
      onProgress: (event) => progress.push(event),
    })

    // Assert
    const gone = {
      session: 0,
      message: 0,
      part: 0,
      tool_call: 0,
      event: 0,
      turn: 0,
      session_command: 0,
      link: 0,
      label: 0,
      forgotten: 1,
    }
    expect({
      result,
      resolved: progress[0],
      main: await rowsOf(MAIN),
      child: await rowsOf(CHILD),
      kept: (await rowsOf(KEPT)).session,
      lockFiles: [existsSync(`${opened().path}.lock`), existsSync(`${opened().path}.labels.lock`)],
    }).toStrictEqual({
      result: {
        outcome: 'ok',
        state: 'rewritten',
        sessionCount: 2,
        labelCount: 2,
        error: null,
        sizeBefore: bytesBefore,
        sizeAfter: bytesOf(opened().path),
        durationMs: expect.any(Number) as number,
      },
      resolved: { phase: 'resolved', named: 1, subagents: 1 },
      main: gone,
      child: gone,
      kept: 1,
      lockFiles: [false, false],
    })
  })

  it("leaves no byte of a phrase only the forgotten session held in the warehouse's files", async () => {
    // Arrange
    const { db, path } = opened()
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const holds = (): boolean =>
      [path, `${path}-wal`].some((file) => existsSync(file) && readFileSync(file).includes(PHRASE))
    const heldBefore = holds()

    // Act
    await forget({ sessions: [MAIN] })

    // Assert
    expect({ heldBefore, heldAfter: holds() }).toStrictEqual({ heldBefore: true, heldAfter: false })
  })

  it('keeps a forgotten session out of the next sync while the harness still lists it', async () => {
    // Arrange
    const adapter = inventedAdapter({
      listing: { kind: 'units', units: [{ locator: 'unit-1', isFingerprintChanging: true }] },
    })
    const sync = async (): Promise<unknown> =>
      runSync({
        adapters: [adapter],
        warehousePath: opened().path,
        onProgress: () => undefined,
        signal: new AbortController().signal,
      })
    await sync()
    const imported = await count(`SELECT count(*) AS count FROM session WHERE ${SYNCED}`)
    const db = await openSqlite(opened().path, { isReadOnly: true })
    const ids = (db.prepare(`SELECT id FROM session WHERE ${SYNCED}`).all() as { id: string }[]).map(({ id }) => id)
    db.close()
    await forget({ sessions: ids })

    // Act
    await sync()

    // Assert
    expect({
      imported,
      afterSync: await count(`SELECT count(*) AS count FROM session WHERE ${SYNCED}`),
    }).toStrictEqual({
      imported: 1,
      afterSync: 0,
    })
  })

  it.each<[string, ForgetTarget, string]>([
    ['an unknown id', { sessions: [MAIN, 'ses_missing'] }, 'The warehouse holds no session ses_missing.'],
    [
      'a project with no session',
      { project: '/home/example/work/empty' },
      'The warehouse holds no session in the project /home/example/work/empty.',
    ],
  ])('refuses %s, naming it, with nothing deleted', async (_case, target, message) => {
    // Act
    const forgetting = forget(target)

    // Assert
    await expect(forgetting).rejects.toMatchObject({ code: WAREHOUSE_ERROR_CODES.WAREHOUSE_SESSION_UNKNOWN, message })
    expect({
      sessions: await count('SELECT count(*) AS count FROM session'),
      forgotten: await count('SELECT count(*) AS count FROM forgotten'),
    }).toStrictEqual({
      sessions: 3,
      forgotten: 0,
    })
  })

  it.each([
    ['the sync lock as sync', 'sync'],
    ['the labelling lock as labels', 'labels'],
  ] as const)('is refused while a live process holds %s, forgetting nothing', async (_case, operation) => {
    // Arrange
    const { path } = opened()
    held = [operation === 'labels' ? takeLabelsLock(path, 'labels') : takeSyncLock(path, 'sync')]
    const fileBefore = sha256(path)

    // Act
    const forgetting = forget({ sessions: [MAIN] })

    // Assert
    await expect(forgetting).rejects.toBeInstanceOf(WarehouseLockHeldError)
    await expect(forgetting).rejects.toMatchObject({ operation, pid: process.pid })
    expect({ file: sha256(path), forgotten: await count('SELECT count(*) AS count FROM forgotten') }).toStrictEqual({
      file: fileBefore,
      forgotten: 0,
    })
  })

  it(
    'holds both locks as forget while its deletion waits, so a sync started meanwhile is refused as already running',
    async () => {
      // Arrange
      const { db, path } = opened()
      // The deletion waits for the write lock until the test ends this transaction.
      db.exec('BEGIN IMMEDIATE')
      const running = spawn(
        process.execPath,
        [
          ...(await typeScriptChildArgs(home)),
          join(home, 'child.mjs'),
          new URL('forget.ts', import.meta.url).href,
          path,
          MAIN,
        ],
        { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] }
      )
      let stdout = ''
      running.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      const closed = new Promise<void>((resolve) => {
        running.on('close', () => {
          resolve()
        })
      })
      await vi.waitFor(
        () => {
          expect(
            [readSyncLock(path), readLabelsLock(path)].map(({ pid, operation }) => ({ pid, operation }))
          ).toStrictEqual([
            { pid: running.pid, operation: 'forget' },
            { pid: running.pid, operation: 'forget' },
          ])
        },
        { timeout: CHILD_TIMEOUT_MS }
      )

      // Act
      const syncing = runSync({
        adapters: [inventedAdapter()],
        warehousePath: path,
        onProgress: () => undefined,
        signal: new AbortController().signal,
      })
      await expect(syncing).rejects.toMatchObject({ operation: 'forget', pid: running.pid })
      db.exec('COMMIT')
      await closed

      // Assert
      expect({
        outcome: (JSON.parse(stdout) as IForgetSessionsResult).outcome,
        forgotten: (await rowsOf(MAIN)).forgotten,
      }).toStrictEqual({
        outcome: 'ok',
        forgotten: 1,
      })
    },
    CHILD_TIMEOUT_MS
  )
})
