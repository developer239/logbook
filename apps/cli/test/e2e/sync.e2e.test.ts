import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { chmod, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import claudeCode from '@log-book/adapter-claude-code'
import openCode from '@log-book/adapter-opencode'
import { openSqlite, openSqliteSync } from '@log-book/core'
import { SCHEMA_VERSION, takeSyncLock } from '@log-book/warehouse'
import { describe, expect, inject, it } from 'vitest'
import { lineDifferences, useE2eHarness, type ICommandResult, type IE2eHome } from './harness.js'

// What a user and a script read from a one-shot sync through the binary: the summary, the problem line last on a
// partial sync, and the exit codes 0, 3, 6, 9 and 10, each on its own copy of the demo small home.
const harness = useE2eHarness()

const CLAUDE_CODE = claudeCode().descriptor.name
const OPENCODE = openCode().descriptor.name
// The demo's writers, by their place in its list: Claude Code, then OpenCode.
const CLAUDE_CODE_WRITER = 0
const OPENCODE_WRITER = 1
const OPENCODE_DATABASE = '.local/share/opencode/opencode.db'

// The small set's counts, from its plan: every session, and the units each adapter imports, Claude Code's transcripts
// holding their subagents and OpenCode's sessions one by one.
const counts = (): {
  sessions: number
  claudeCodeSessions: string[]
  claudeCodeUnits: number
  openCodeUnits: number
} => {
  const { plan } = inject('e2eDemo')
  const planned = plan.plan.sessions
  return {
    sessions: planned.length,
    claudeCodeSessions: planned
      .filter((session) => session.writer === CLAUDE_CODE_WRITER)
      .map((session) => plan.ids[session.key] ?? session.key)
      .toSorted(),
    claudeCodeUnits: planned.filter((session) => session.writer === CLAUDE_CODE_WRITER && session.parentKey === null)
      .length,
    openCodeUnits: planned.filter((session) => session.writer === OPENCODE_WRITER).length,
  }
}

const summary = (claudeCodeField: string, openCodeField: string, sessions: number): string[] => [
  '# Sync',
  '',
  `**${CLAUDE_CODE}:** ${claudeCodeField}`,
  `**${OPENCODE}:** ${openCodeField}`,
  `**Sessions in the warehouse:** ${String(sessions)}`,
  '**Took:** {duration}',
]

const warehouseOf = (home: IE2eHome): string => home.environment.LOGBOOK_DB ?? join(home.out, 'warehouse.db')

const query = async <TRow>(warehouse: string, sql: string): Promise<TRow[]> => {
  const db = await openSqlite(warehouse, { isReadOnly: true })
  try {
    return (db.prepare(sql).all() as object[]).map((row) => ({ ...row }) as TRow)
  } finally {
    db.close()
  }
}

const syncRuns = async (warehouse: string): Promise<number> =>
  (await query<{ runs: number }>(warehouse, 'SELECT count(*) AS runs FROM sync_run'))[0]?.runs ?? 0

const sha256Of = async (path: string): Promise<string> =>
  existsSync(path)
    ? createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    : 'absent'

describe('logbook sync through the binary', () => {
  it('exits 0 with the summary, and a second sync imports nothing and finds every unit unchanged', async () => {
    // Arrange
    const home = await harness.createHome()
    const { sessions, claudeCodeUnits, openCodeUnits } = counts()

    // Act
    const first = await harness.run(home, ['sync'])
    const second = await harness.run(home, ['sync'])

    // Assert
    expect({
      codes: [first.code, second.code],
      first: lineDifferences(
        first.stdout,
        summary(
          `${String(claudeCodeUnits)} imported, 0 unchanged`,
          `${String(openCodeUnits)} imported, 0 unchanged`,
          sessions
        )
      ),
      second: lineDifferences(
        second.stdout,
        summary(
          `0 imported, ${String(claudeCodeUnits)} unchanged`,
          `0 imported, ${String(openCodeUnits)} unchanged`,
          sessions
        )
      ),
    }).toStrictEqual({ codes: [0, 0], first: [], second: [] })
  })

  it("exits 10 with the problem line last when OpenCode's database cannot be read", async () => {
    // Arrange
    const home = await harness.createHome()
    const database = join(home.environment.HOME ?? '', OPENCODE_DATABASE)
    await chmod(database, 0o000)
    // The case holds only where file modes do: under root the database still opens, and the test fails here.
    const reason = ((): string => {
      try {
        openSqliteSync(database, { isReadOnly: true }).close()
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      throw new Error(`${database} still opens at mode 000; file modes do not hold here, as under root`)
    })()
    const { claudeCodeSessions, claudeCodeUnits } = counts()
    const shown = `~/${OPENCODE_DATABASE}`
    const problem = `${OPENCODE}: cannot read ${shown}: Cannot open ${shown}: ${reason}`

    // Act
    const sync = await harness.run(home, ['sync'])

    // Assert
    expect({
      code: sync.code,
      stdout: lineDifferences(
        sync.stdout,
        summary(
          `${String(claudeCodeUnits)} imported, 0 unchanged`,
          '0 imported, 0 unchanged',
          claudeCodeSessions.length
        )
      ),
      lastError: sync.stderr.at(-1),
      sessions: (await query<{ id: string }>(warehouseOf(home), 'SELECT id FROM session ORDER BY id')).map(
        ({ id }) => id
      ),
      newestRun: (
        await query<{ outcome: string; error: string; isEnded: number }>(
          warehouseOf(home),
          'SELECT outcome, error, ended_at IS NOT NULL AS isEnded FROM sync_run ORDER BY id DESC LIMIT 1'
        )
      )[0],
    }).toStrictEqual({
      code: 10,
      stdout: [],
      lastError: `Sync finished with 1 problem: ${problem}`,
      sessions: claudeCodeSessions,
      newestRun: { outcome: 'partial', error: problem, isEnded: 1 },
    })
  })

  it.each([
    [
      'sync',
      (pid: number, lock: string) =>
        `A sync is already running on this warehouse (pid ${String(pid)}, lock file ${lock}). If none is running, ` +
        'delete that file.',
    ],
    [
      'compact',
      (pid: number, lock: string) =>
        `Maintenance is running on this warehouse: logbook compact is rewriting it (pid ${String(pid)}, lock file ` +
        `${lock}). Run this again once it has ended. If none is running, delete that file.`,
    ],
  ] as const)('exits 3 when a %s holds the sync lock, and records no run', async (operation, line) => {
    // Arrange
    const home = await harness.createHome({ isWarehouseCopied: true })
    const warehouse = warehouseOf(home)
    const runsBefore = await syncRuns(warehouse)
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1e9)'], { stdio: 'ignore' })
    const lock = takeSyncLock(warehouse, operation, { pid: holder.pid ?? 0 })

    // Act
    let sync: ICommandResult
    try {
      sync = await harness.run(home, ['sync'])
    } finally {
      lock.release()
      holder.kill('SIGKILL')
      await once(holder, 'exit')
    }

    // Assert
    expect({ code: sync.code, stderr: sync.stderr, runs: await syncRuns(warehouse) }).toStrictEqual({
      code: 3,
      stderr: [line(holder.pid ?? 0, `${warehouse}.lock`)],
      runs: runsBefore,
    })
  })

  it('exits 6 from sync, sessions and start on a warehouse at a newer schema, leaving it as it was', async () => {
    // Arrange
    const home = await harness.createHome({ isWarehouseCopied: true })
    const warehouse = warehouseOf(home)
    const db = openSqliteSync(warehouse, { isReadOnly: false })
    db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION + 1)}`)
    db.close()
    const before = [await sha256Of(warehouse), await sha256Of(`${warehouse}-wal`)]
    const message =
      `The warehouse is at schema ${String(SCHEMA_VERSION + 1)}; this Log Book ({version}) reads schema ` +
      `${String(SCHEMA_VERSION)}. Update with npm install -g @log-book/cli@latest.`

    // Act
    const results = [
      await harness.run(home, ['sync']),
      await harness.run(home, ['sessions']),
      await harness.run(home, ['start', '--port', '0', '--no-open', '--no-sync']),
    ]

    // Assert
    expect({
      codes: results.map(({ code }) => code),
      messages: results.map(({ stderr }) => lineDifferences(stderr.slice(-1), [message])),
      bytes: [await sha256Of(warehouse), await sha256Of(`${warehouse}-wal`)],
      isHostFile: existsSync(`${warehouse}.host`),
    }).toStrictEqual({ codes: [6, 6, 6], messages: [[], [], []], bytes: before, isHostFile: false })
  })

  it('exits 9 when the host that started it is another version, and creates no warehouse or lock', async () => {
    // Arrange
    const home = await harness.createHome()
    const warehouse = warehouseOf(home)

    // Act
    const sync = await harness.run(home, ['sync'], { env: { LOGBOOK_HOST_VERSION: '0.0.1' } })

    // Assert
    expect({
      code: sync.code,
      stderr: sync.stderr,
      isWarehouse: existsSync(warehouse),
      isLock: existsSync(`${warehouse}.lock`),
    }).toStrictEqual({
      code: 9,
      stderr: ['Log Book was updated while running. Press Ctrl+C and start logbook again.'],
      isWarehouse: false,
      isLock: false,
    })
  })
})
