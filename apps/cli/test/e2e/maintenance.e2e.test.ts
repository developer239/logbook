import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { openSqliteSync } from '@log-book/core'
import { readLabelsLock, readSyncLock } from '@log-book/warehouse'
import { describe, expect, inject, it, vi } from 'vitest'
import { lineDifferences, useE2eHarness, type IE2eHome, type IRunningCommand } from './harness.js'

// forget and compact through the binary: what they remove and give back, and that a signal stops either at once and
// leaves the warehouse as it was. A rewrite on the command's own thread would stop only after SQLite's 5-second busy
// timeout; a rewrite process the command kills stops at once.
const harness = useE2eHarness()
const run = promisify(execFile)

const BUSY_TIMEOUT_MS = 5000
const POLL_MS = 25
const SIZE = String.raw`[\d,]+ MB|\d+\.\d GB`
const SIZES = new RegExp(`(?<before>${SIZE}) before, (?<after>${SIZE}) after\\.$`, 'u')
const COMPACT_STOPPED =
  'Compacting stopped. SQLite rolled the rewrite back, so the warehouse file is unchanged: {size}, the same rows.'
const FORGET_STOPPED =
  'Forgetting stopped before anything was deleted. Nothing was forgotten, and the warehouse file is unchanged.'

const warehouseOf = (home: IE2eHome): string => home.environment.LOGBOOK_DB ?? ''

const bytesOf = (size: string): number =>
  size.endsWith(' GB') ? Number(size.slice(0, -3)) * 1e9 : Number(size.slice(0, -3).replaceAll(',', '')) * 1e6

// Whether a line's second size is not larger than its first.
const isNotLarger = (line: string | undefined): boolean => {
  const sizes = SIZES.exec(line ?? '')?.groups
  return sizes?.before !== undefined && sizes.after !== undefined && bytesOf(sizes.after) <= bytesOf(sizes.before)
}

const counted = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`

// The plan's top-level session with the most subagent sessions, with the warehouse ids of it and of its subagents.
const sessionWithSubagents = (): { id: string; subagents: string[] } => {
  const { plan } = inject('e2eDemo')
  const descendantsOf = (key: string): string[] =>
    plan.plan.sessions
      .filter((session) => session.parentKey === key)
      .flatMap((child) => [child.key, ...descendantsOf(child.key)])
  const [chosen] = plan.plan.sessions
    .filter((session) => session.parentKey === null)
    .map((session) => ({ key: session.key, descendants: descendantsOf(session.key) }))
    .toSorted((left, right) => right.descendants.length - left.descendants.length)
  const idOf = (key: string): string => plan.ids[key] ?? key
  if (chosen === undefined || chosen.descendants.length === 0) {
    throw new Error('the small set has no session with subagent sessions')
  }
  return { id: idOf(chosen.key), subagents: chosen.descendants.map(idOf) }
}

const read = <TRow>(warehouse: string, sql: string, ...params: string[]): TRow[] => {
  const db = openSqliteSync(warehouse, { isReadOnly: true })
  try {
    return (db.prepare(sql).all(...params) as object[]).map((row) => ({ ...row }) as TRow)
  } finally {
    db.close()
  }
}

// Every label of a session and its subagent sessions, as forget counts them: by the record id or its prefix.
const LABELS_OF_TREE = `
  WITH RECURSIVE tree(id) AS (
    SELECT ? UNION
    SELECT link.child_session_id FROM link JOIN tree ON link.parent_session_id = tree.id WHERE link.kind = 'subagent')
  SELECT count(*) AS labels FROM label WHERE EXISTS (
    SELECT 1 FROM tree WHERE label.record_id = tree.id
      OR substr(label.record_id, 1, length(tree.id) + 1) = tree.id || '/')`

const sessionsLeft = (warehouse: string, ids: readonly string[]): number =>
  read<{ id: string }>(warehouse, 'SELECT id FROM session').filter(({ id }) => ids.includes(id)).length

// The rows of every table but the full-text index's own segments, which a compaction rewrites.
const rowCounts = (warehouse: string): Record<string, number | undefined> =>
  Object.fromEntries(
    read<{ name: string }>(
      warehouse,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'part_fts_%' ORDER BY name"
    ).map(({ name }) => [name, read<{ rows: number }>(warehouse, `SELECT count(*) AS rows FROM "${name}"`)[0]?.rows])
  )

const lockFilesLeft = (warehouse: string): string[] =>
  [`${warehouse}.lock`, `${warehouse}.labels.lock`].filter((file) => existsSync(file))

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Waits until both locks name the command and the operation and its rewrite process is running, and returns that
// process's pid.
const rewriteOf = async (warehouse: string, command: IRunningCommand, operation: string): Promise<number> =>
  vi.waitFor(
    async () => {
      const locks = [readSyncLock(warehouse), readLabelsLock(warehouse)]
      if (locks.some((lock) => lock.pid !== command.pid || lock.operation !== operation)) {
        throw new Error(`both locks do not name ${operation} by ${String(command.pid)} yet`)
      }
      const { stdout } = await run('pgrep', ['-P', String(command.pid)]).catch(() => ({ stdout: '' }))
      const [rewrite] = stdout
        .split('\n')
        .filter((line) => line !== '')
        .map(Number)
      if (rewrite === undefined) {
        throw new Error('the rewrite process has not started yet')
      }
      return rewrite
    },
    { timeout: BUSY_TIMEOUT_MS - 1000, interval: POLL_MS }
  )

// SQLite's write lock held by the test, so the rewrite process waits in its busy timeout until the test lets go.
const holdWriteLock = (warehouse: string): { release: () => void } => {
  const db = openSqliteSync(warehouse, { isReadOnly: false })
  db.exec('BEGIN IMMEDIATE')
  let isHeld = true
  return {
    release: () => {
      if (isHeld) {
        db.exec('ROLLBACK')
        db.close()
        isHeld = false
      }
    },
  }
}

// How a stop reaches the command: Ctrl+C in a terminal signals its whole group; a kill names its pid.
const STOPS = [
  { name: 'SIGINT to the group, as Ctrl+C sends it', signal: 'SIGINT', isGroup: true },
  { name: 'SIGINT to the pid', signal: 'SIGINT', isGroup: false },
  { name: 'SIGTERM to the pid', signal: 'SIGTERM', isGroup: false },
] as const

const stop = async (
  command: IRunningCommand,
  { signal, isGroup }: { signal: NodeJS.Signals; isGroup: boolean }
): Promise<{ code: number | null; ms: number }> => {
  const sentAt = performance.now()
  process.kill(isGroup ? -command.pid : command.pid, signal)
  const code = await command.closed
  return { code, ms: Math.round(performance.now() - sentAt) }
}

describe('forget and compact through the binary', () => {
  it('forgets a session and its subagent sessions, then compacts, each giving space back', async () => {
    // Arrange
    const home = await harness.createHome({ isWarehouseCopied: true })
    const warehouse = warehouseOf(home)
    const { id, subagents } = sessionWithSubagents()
    const [{ labels } = { labels: 0 }] = read<{ labels: number }>(warehouse, LABELS_OF_TREE, id)
    const compacting = `Compacting ${warehouse} (`

    // Act
    const forget = await harness.run(home, ['forget', id])
    const afterForget = { left: sessionsLeft(warehouse, [id, ...subagents]), locks: lockFilesLeft(warehouse) }
    const compact = await harness.run(home, ['compact'])

    // Assert
    expect({
      forget: {
        code: forget.code,
        forgetting: forget.stderr.includes(
          `Forgetting 1 session and its ${counted(subagents.length, 'subagent session', 'subagent sessions')}.`
        ),
        isCompacting: forget.stderr.some((line) => line.startsWith(compacting)),
        last: lineDifferences(forget.stdout.slice(-1), [
          `Forgot ${counted(subagents.length + 1, 'session', 'sessions')} and ${counted(labels, 'label', 'labels')}. ` +
            'Warehouse {size} before, {size} after.',
        ]),
        isNotLarger: isNotLarger(forget.stdout.at(-1)),
        ...afterForget,
      },
      compact: {
        code: compact.code,
        isCompacting: compact.stderr.some((line) => line.startsWith(compacting)),
        stdout: lineDifferences(compact.stdout, ['Compacted in {duration}: {size} before, {size} after.']),
        isNotLarger: isNotLarger(compact.stdout.at(-1)),
        locks: lockFilesLeft(warehouse),
      },
    }).toStrictEqual({
      forget: { code: 0, forgetting: true, isCompacting: true, last: [], isNotLarger: true, left: 0, locks: [] },
      compact: { code: 0, isCompacting: true, stdout: [], isNotLarger: true, locks: [] },
    })
  })

  it.for(STOPS)('stops a compaction at once on $name, leaving the warehouse as it was', async (how, { annotate }) => {
    // Arrange
    const home = await harness.createHome({ isWarehouseCopied: true })
    const warehouse = warehouseOf(home)
    const rowsBefore = rowCounts(warehouse)
    const hold = holdWriteLock(warehouse)
    let stopped: { code: number | null; ms: number; rewrite: number; output: string[] }
    try {
      const command = await harness.startCommand(home, ['compact'])
      const rewrite = await rewriteOf(warehouse, command, 'compact')

      // Act
      const { code, ms } = await stop(command, how)
      stopped = { code, ms, rewrite, output: command.output().stderr }
    } finally {
      hold.release()
    }
    await annotate(`stopped ${String(stopped.ms)} ms after ${how.name}`)

    // Assert
    expect({
      code: stopped.code,
      last: lineDifferences(stopped.output.slice(-1), [COMPACT_STOPPED]),
      isBeforeBusyTimeout: stopped.ms < BUSY_TIMEOUT_MS,
      rows: rowCounts(warehouse),
      integrity: read<{ integrity_check: string }>(warehouse, 'PRAGMA integrity_check'),
      locks: lockFilesLeft(warehouse),
      isRewriteAlive: isProcessAlive(stopped.rewrite),
    }).toStrictEqual({
      code: 130,
      last: [],
      isBeforeBusyTimeout: true,
      rows: rowsBefore,
      integrity: [{ integrity_check: 'ok' }],
      locks: [],
      isRewriteAlive: false,
    })
  })

  it('stops a forget before anything is deleted on SIGINT to its group', async ({ annotate }) => {
    // Arrange
    const home = await harness.createHome({ isWarehouseCopied: true })
    const warehouse = warehouseOf(home)
    const { id, subagents } = sessionWithSubagents()
    const hold = holdWriteLock(warehouse)
    let stopped: { code: number | null; ms: number; output: string[] }
    try {
      const command = await harness.startCommand(home, ['forget', id])
      await rewriteOf(warehouse, command, 'forget')

      // Act
      const { code, ms } = await stop(command, STOPS[0])
      stopped = { code, ms, output: command.output().stderr }
    } finally {
      hold.release()
    }
    await annotate(`stopped ${String(stopped.ms)} ms after ${STOPS[0].name}`)

    // Assert
    expect({
      code: stopped.code,
      last: stopped.output.at(-1),
      isBeforeBusyTimeout: stopped.ms < BUSY_TIMEOUT_MS,
      left: sessionsLeft(warehouse, [id, ...subagents]),
      locks: lockFilesLeft(warehouse),
    }).toStrictEqual({
      code: 130,
      last: FORGET_STOPPED,
      isBeforeBusyTimeout: true,
      left: subagents.length + 1,
      locks: [],
    })
  })
})
