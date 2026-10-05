import { spawn, spawnSync } from 'node:child_process'
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
  WarehouseLockHeldError,
  type IHeldLock,
} from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runSync } from '../sync/sync.js'
import { runCompact, type ICompactResult } from './compact.js'

const CHILD_TIMEOUT_MS = 20_000
const MEGABYTE = 1024 * 1024
const PADDING_ROWS = 64
// The write-ahead log a stopped `VACUUM` has written when the test stops it: well inside the rewrite, far from its end.
const STOP_AT_WAL_BYTES = 4 * MEGABYTE

// Runs a compaction that SIGINT stops, and prints its result.
const COMPACTING_CHILD = `const [compactUrl, warehousePath] = process.argv.slice(2)
const { runCompact } = await import(compactUrl)
const controller = new AbortController()
process.on('SIGINT', () => controller.abort(new Error('SIGINT')))
const result = await runCompact({ warehousePath, signal: controller.signal, onProgress: () => {} })
process.stdout.write(JSON.stringify(result))
`

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

const bytesOf = (path: string): number =>
  statSync(path).size + (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0)

const lockFiles = (path: string): boolean[] => [existsSync(`${path}.lock`), existsSync(`${path}.labels.lock`)]

// Each table's row count, without the full-text index's own tables, whose segments the compaction rewrites.
const tableRows = async (path: string): Promise<Record<string, number>> => {
  const db = await openSqlite(path, { isReadOnly: true })
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'part_fts_%' ORDER BY name")
      .all() as { name: string }[]
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        (db.prepare(`SELECT count(*) AS count FROM ${name}`).get() as { count: number }).count,
      ])
    )
  } finally {
    db.close()
  }
}

const readOnly = async <TRow>(path: string, sql: string): Promise<TRow> => {
  const db = await openSqlite(path, { isReadOnly: true })
  try {
    return { ...(db.prepare(sql).get() as object) } as TRow
  } finally {
    db.close()
  }
}

const integrity = async (path: string): Promise<unknown> => readOnly(path, 'PRAGMA integrity_check')

// The child processes of a pid, from pgrep.
const childrenOf = (pid: number): number[] =>
  spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter((line) => line !== '')
    .map(Number)

describe('runCompact', () => {
  let home = ''
  let warehouse: ITestWarehouse | null = null
  let held: IHeldLock[] = []

  const opened = (): ITestWarehouse => {
    if (warehouse === null) {
      throw new Error('The warehouse is not open.')
    }
    return warehouse
  }

  const compact = async (signal: AbortSignal = new AbortController().signal): Promise<ICompactResult> =>
    runCompact({ warehousePath: opened().path, signal, onProgress: () => undefined })

  // A compaction run by a child script, which SIGINT stops.
  const compactInChild = (): { pid: number; result: Promise<ICompactResult> } => {
    const running = spawn(
      process.execPath,
      [join(home, 'child.mjs'), new URL('compact.ts', import.meta.url).href, opened().path],
      {
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'inherit'],
      }
    )
    let stdout = ''
    running.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    const result = new Promise<ICompactResult>((resolve) => {
      running.on('close', () => {
        resolve(JSON.parse(stdout) as ICompactResult)
      })
    })
    return { pid: running.pid ?? 0, result }
  }

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'log-book-compact-home-')))
    vi.stubEnv('HOME', home)
    await writeFile(join(home, 'child.mjs'), COMPACTING_CHILD)
    warehouse = await createTestWarehouse()
    // The mode every warehouse runs in, which the rewrite needs to leave a stopped file as it was.
    warehouse.db.exec('PRAGMA journal_mode = WAL')
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

  it('shrinks the file after deleted rows and repeated syncs, keeping every row, and releases both locks', async () => {
    // Arrange
    const { db, path } = opened()
    for (let index = 0; index < 200; index += 1) {
      insert(db, 'part', {
        message_id: 'm',
        session_id: 's',
        idx: index,
        kind: 'text',
        text: 'saved cart '.repeat(1_000),
      })
    }
    db.exec("DELETE FROM part WHERE session_id = 's'")
    const adapter = inventedAdapter({
      listing: { kind: 'units', units: [{ locator: 'unit-1', isFingerprintChanging: true }] },
    })
    await [1, 2, 3, 4, 5].reduce(async (previous) => {
      await previous
      await runSync({
        adapters: [adapter],
        warehousePath: path,
        onProgress: () => undefined,
        signal: new AbortController().signal,
      })
    }, Promise.resolve())
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const [rowsBefore, fileBefore, bytesBefore] = [await tableRows(path), statSync(path).size, bytesOf(path)]

    // Act
    const result = await compact()

    // Assert
    expect({
      result,
      isSmaller: statSync(path).size < fileBefore,
      integrity: await integrity(path),
      rows: await tableRows(path),
      lockFiles: lockFiles(path),
    }).toStrictEqual({
      result: {
        outcome: 'ok',
        isRewritten: true,
        error: null,
        sizeBefore: bytesBefore,
        sizeAfter: bytesOf(path),
        durationMs: expect.any(Number) as number,
      },
      isSmaller: true,
      integrity: { integrity_check: 'ok' },
      rows: rowsBefore,
      lockFiles: [false, false],
    })
  })

  it("fails with SQLite's message and releases both locks after an error in the rewrite", async () => {
    // Arrange
    const { db, path } = opened()
    db.exec('DROP TABLE part_fts')

    // Act
    const result = await compact()

    // Assert
    expect({ result, lockFiles: lockFiles(path) }).toStrictEqual({
      result: {
        outcome: 'failed',
        isRewritten: false,
        error: 'no such table: part_fts',
        sizeBefore: expect.any(Number) as number,
        sizeAfter: bytesOf(path),
        durationMs: expect.any(Number) as number,
      },
      lockFiles: [false, false],
    })
  })

  it.each([
    ['the sync lock', 'sync'],
    ['the sync lock', 'compact'],
    ['the sync lock', 'forget'],
    ['the labelling lock', 'labels'],
  ] as const)('is refused while a live process holds %s as %s, changing nothing', async (lock, operation) => {
    // Arrange
    const { path } = opened()
    held = [operation === 'labels' ? takeLabelsLock(path, 'labels') : takeSyncLock(path, operation)]
    const fileBefore = sha256(path)

    // Act
    const compacting = compact()

    // Assert
    await expect(compacting).rejects.toBeInstanceOf(WarehouseLockHeldError)
    await expect(compacting).rejects.toMatchObject({ operation, pid: process.pid })
    expect({ file: sha256(path), syncLock: readSyncLock(path).operation }).toStrictEqual({
      file: fileBefore,
      syncLock: lock === 'the sync lock' ? operation : null,
    })
  })

  it(
    'holds both locks for the whole run, so a sync started meanwhile is refused as already running',
    async () => {
      // Arrange
      const { db, path } = opened()
      // The rewrite process waits at its first write until the test ends this transaction.
      db.exec('BEGIN IMMEDIATE')
      const child = compactInChild()
      await vi.waitFor(
        () => {
          expect(
            [readSyncLock(path), readLabelsLock(path)].map(({ pid, operation }) => ({ pid, operation }))
          ).toStrictEqual([
            { pid: child.pid, operation: 'compact' },
            { pid: child.pid, operation: 'compact' },
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
      await expect(syncing).rejects.toMatchObject({ operation: 'compact', pid: child.pid })
      db.exec('COMMIT')
      const result = await child.result

      // Assert
      expect({ outcome: result.outcome, lockFiles: lockFiles(path) }).toStrictEqual({
        outcome: 'ok',
        lockFiles: [false, false],
      })
    },
    CHILD_TIMEOUT_MS
  )

  it(
    'leaves the file as it was after a stop inside VACUUM',
    async () => {
      // Arrange: 64 MB with half its pages free.
      const { db, path } = opened()
      db.exec('CREATE TABLE padding (id INTEGER PRIMARY KEY, data BLOB NOT NULL)')
      for (let id = 1; id <= PADDING_ROWS; id += 1) {
        db.prepare('INSERT INTO padding (id, data) VALUES (?, randomblob(?))').run(id, MEGABYTE)
      }
      db.exec('DELETE FROM padding WHERE id % 2 = 0')
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const [fileBefore, rowsBefore] = [sha256(path), await tableRows(path)]
      const { page_count: pagesBefore } = await readOnly<{ page_count: number }>(path, 'PRAGMA page_count')
      const child = compactInChild()
      const rewriter = await vi.waitFor(
        () => {
          const [pid] = childrenOf(child.pid)
          if (pid === undefined) {
            throw new Error('The rewrite process has not started yet.')
          }
          return pid
        },
        { timeout: CHILD_TIMEOUT_MS, interval: 5 }
      )
      const wal = `${path}-wal`
      const deadline = Date.now() + CHILD_TIMEOUT_MS
      while ((!existsSync(wal) || statSync(wal).size <= STOP_AT_WAL_BYTES) && Date.now() < deadline) {
        // Polled without yielding, so the stop lands inside the rewrite.
      }
      process.kill(rewriter, 'SIGSTOP')
      // Caught too late when the rewrite had already committed.
      expect(await readOnly(path, 'PRAGMA page_count')).toStrictEqual({ page_count: pagesBefore })

      // Act
      process.kill(child.pid, 'SIGINT')
      const result = await child.result

      // Assert
      expect({
        outcome: result.outcome,
        isRewritten: result.isRewritten,
        file: sha256(path),
        integrity: await integrity(path),
        rows: await tableRows(path),
        lockFiles: lockFiles(path),
      }).toStrictEqual({
        outcome: 'stopped',
        isRewritten: false,
        file: fileBefore,
        integrity: { integrity_check: 'ok' },
        rows: rowsBefore,
        lockFiles: [false, false],
      })
    },
    CHILD_TIMEOUT_MS * 2
  )
})
