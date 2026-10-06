import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { openSqliteSync } from '@log-book/core'
import { installFakeClaude, type IFakeClaude } from '@log-book/engine/testing'
import { SCHEMA_VERSION } from '@log-book/warehouse'
import { describe, expect, inject, it, vi } from 'vitest'
import { lineDifferences, useE2eHarness, type IE2eHome, type IStartedHost } from './harness.js'

// What a user sees the first time they type logbook, and what the host leaves on disk, through the binary.
const harness = useE2eHarness()

const MODE_BITS = 0o777
const OPENCODE_DATABASE = '.local/share/opencode/opencode.db'
const LOGS = '.local/share/log-book/logs'
const FIRST_SYNC_TIMEOUT_MS = 45_000
const SCHEDULED_SYNC_TIMEOUT_MS = 130_000
const STOP_BOUND_MS = 10_000
const POLL_MS = 50
// A scheduled sync's line, which opens with the minute it ended.
const SCHEDULED_LINE = /^\d{2}:\d{2} sync: /u
const POSTED_SYNCS = 21
const KEPT_LOGS = 20
// The demo's writers, by their place in its list: Claude Code, then OpenCode.
const CLAUDE_CODE_WRITER = 0
const OPENCODE_WRITER = 1

const CLAUDE_FOUND = 'Claude Code  found at ~/.claude/projects'
const OPENCODE_FOUND = `OpenCode     found at ~/${OPENCODE_DATABASE}`
const CLAUDE_MISSING =
  'Claude Code  not on this machine (no ~/.claude/projects; set CLAUDE_CONFIG_DIR if Claude Code keeps its data elsewhere)'
const OPENCODE_MISSING =
  `OpenCode     not on this machine (no ~/${OPENCODE_DATABASE}; set OPENCODE_DB if OpenCode keeps its data ` +
  'elsewhere)'
const NO_AGENT_DATA =
  'No agent data found yet. Log Book reads what Claude Code and OpenCode keep on this machine; it will pick them up ' +
  'on the next sync once either has run here.'
const URL_LINE = 'Log Book is running at http://127.0.0.1:{port}'
const READING = 'First sync   reading your whole history (about half a minute per thousand sessions)'
const LABELLING_READY =
  'Labelling    ready: claude 2.1.286, signed in with a Claude subscription; default model claude-haiku-4-5'
const LABELLING_MISSING =
  'Labelling    needs Claude Code: install it (https://claude.com/claude-code) or set CLAUDE_BIN'

// The small set's counts, from its plan: its sessions, subagents included, and the units each adapter imports,
// Claude Code's transcripts holding their subagents and OpenCode's sessions one by one.
const counts = (): { sessions: number; claudeCodeUnits: number; openCodeUnits: number } => {
  const planned = inject('e2eDemo').plan.plan.sessions
  return {
    sessions: planned.length,
    claudeCodeUnits: planned.filter((session) => session.writer === CLAUDE_CODE_WRITER && session.parentKey === null)
      .length,
    openCodeUnits: planned.filter((session) => session.writer === OPENCODE_WRITER).length,
  }
}

const warehouseOf = (home: IE2eHome): string => home.environment.LOGBOOK_DB ?? ''
const logsOf = (home: IE2eHome): string => join(home.environment.HOME ?? '', LOGS)
const warehouseLine = (home: IE2eHome): string =>
  `Warehouse    ${warehouseOf(home)}, created at schema ${String(SCHEMA_VERSION)}`

const read = <TRow>(warehouse: string, sql: string): TRow[] => {
  const db = openSqliteSync(warehouse, { isReadOnly: true })
  try {
    return (db.prepare(sql).all() as object[]).map((row) => ({ ...row }) as TRow)
  } finally {
    db.close()
  }
}

const syncRuns = (home: IE2eHome): number =>
  read<{ runs: number }>(warehouseOf(home), 'SELECT count(*) AS runs FROM sync_run')[0]?.runs ?? 0

const fakeIn = async (home: IE2eHome): Promise<{ fake: IFakeClaude; bin: string }> => {
  const bin = join(home.out, 'claude-bin')
  await mkdir(bin)
  return { fake: await installFakeClaude(bin), bin }
}

// Waits for the first stdout line that starts so, and returns it.
const lineStarting = async (host: IStartedHost, start: string, timeout = FIRST_SYNC_TIMEOUT_MS): Promise<string> =>
  vi.waitFor(
    () => {
      const line = host.output().stdout.find((candidate) => candidate.startsWith(start))
      if (line === undefined) {
        throw new Error(`no line starting ${JSON.stringify(start)} yet: ${host.output().stdout.join(' | ')}`)
      }
      return line
    },
    { timeout, interval: POLL_MS }
  )

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode % (MODE_BITS + 1)

const logNames = async (home: IE2eHome): Promise<string[]> => (await readdir(logsOf(home))).toSorted()

describe('the host through the binary', () => {
  it('runs a first run: discovery, the URL, the first sync, labelling ready and never started, then stops', async () => {
    // Arrange
    const home = await harness.createHome()
    const { fake, bin } = await fakeIn(home)
    const { sessions, claudeCodeUnits, openCodeUnits } = counts()

    // Act
    const host = await harness.startHost(home, { args: ['--no-open'], firstOnPath: bin })
    const done = await lineStarting(host, 'First sync   done in ')
    await lineStarting(host, 'Labelling    ')
    const [root, conversations] = [await fetch(host.url), await fetch(`${host.url}/conversations?range=all`)]
    const conversationsPage = await conversations.text()
    const calls = (await fake.readRecords()).map((record) => record.argv)
    const code = await host.stop()

    // Assert
    const { stdout } = host.output()
    const labelling = stdout.findIndex((line) => line.startsWith('Labelling    '))
    const urlAt = stdout.findIndex((line) => line.startsWith('Log Book is running at '))
    expect({
      opening: lineDifferences(stdout.filter((_line, index) => index !== labelling).slice(0, 9), [
        'Log Book {version}',
        warehouseLine(home),
        CLAUDE_FOUND,
        OPENCODE_FOUND,
        '',
        URL_LINE,
        'Press Ctrl+C to stop.',
        '',
        READING,
      ]),
      done: lineDifferences(
        [done],
        [
          `First sync   done in {duration}: ${String(claudeCodeUnits + openCodeUnits)} sessions. Next sync in 5 minutes.`,
        ]
      ),
      labelling: { line: stdout[labelling], isAfterUrl: labelling > urlAt },
      pages: { root: root.status, conversations: conversationsPage.includes(`${String(sessions)} conversations`) },
      calls,
      code,
      left: [`${warehouseOf(home)}.host`, `${warehouseOf(home)}.lock`].filter((file) => existsSync(file)),
    }).toStrictEqual({
      opening: [],
      done: [],
      labelling: { line: LABELLING_READY, isAfterUrl: true },
      pages: { root: 200, conversations: true },
      calls: [['--version'], ['auth', 'status', '--json']],
      code: 0,
      left: [],
    })
  })

  it('keeps its files private, and the newest 20 sync logs after 22 syncs', async () => {
    // Arrange
    const home = await harness.createHome()
    const host = await harness.startHost(home, { args: ['--no-open'] })
    await lineStarting(host, 'First sync   done in ')
    const hostFile = JSON.parse(await readFile(`${warehouseOf(home)}.host`, 'utf8')) as { pid: number; port: number }
    const modes = {
      hostFile: await modeOf(`${warehouseOf(home)}.host`),
      logs: await modeOf(logsOf(home)),
      logFiles: await Promise.all((await logNames(home)).map(async (name) => modeOf(join(logsOf(home), name)))),
    }
    const firstLogs = await logNames(home)

    // Act
    const posted = await Array.from({ length: POSTED_SYNCS }).reduce<
      Promise<{ statuses: number[]; isRunAdded: boolean[]; logs: string[] }>
    >(
      async (previous) => {
        const sofar = await previous
        const [runsBefore, logsBefore] = [syncRuns(home), await logNames(home)]
        const response = await fetch(`${host.url}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': host.url },
          body: 'back=%2F',
          redirect: 'manual',
        })
        await response.text()
        const added = (await logNames(home)).filter((name) => !logsBefore.includes(name))
        return {
          statuses: [...sofar.statuses, response.status],
          isRunAdded: [...sofar.isRunAdded, syncRuns(home) === runsBefore + 1],
          logs: [...sofar.logs, ...added],
        }
      },
      Promise.resolve({ statuses: [], isRunAdded: [], logs: firstLogs })
    )
    const kept = await vi.waitFor(
      async () => {
        const names = await logNames(home)
        if (names.length !== KEPT_LOGS) {
          throw new Error(`${String(names.length)} logs are kept, not ${String(KEPT_LOGS)}`)
        }
        return names
      },
      { timeout: 5000, interval: POLL_MS }
    )

    // Assert
    expect({
      hostFile,
      modes,
      statuses: posted.statuses,
      isRunAdded: posted.isRunAdded,
      written: posted.logs.length,
      kept,
    }).toStrictEqual({
      hostFile: {
        pid: host.pid,
        port: Number(new URL(host.url).port),
        version: expect.any(String) as string,
        startedAt: expect.any(Number) as number,
      },
      modes: { hostFile: 0o600, logs: 0o700, logFiles: firstLogs.map(() => 0o600) },
      statuses: Array.from({ length: POSTED_SYNCS }, () => 303),
      isRunAdded: Array.from({ length: POSTED_SYNCS }, () => true),
      written: POSTED_SYNCS + 1,
      kept: posted.logs.slice(-KEPT_LOGS).toSorted(),
    })
  }, 60_000)

  it.for([
    { home: 'demo', discovery: [CLAUDE_FOUND, OPENCODE_FOUND, ''] },
    { home: 'one-harness', discovery: [CLAUDE_FOUND, OPENCODE_MISSING, ''] },
    { home: 'claude-code-empty', discovery: [CLAUDE_FOUND, OPENCODE_FOUND, ''] },
    { home: 'none', discovery: [CLAUDE_MISSING, OPENCODE_MISSING, '', NO_AGENT_DATA, ''] },
  ] as const)('prints the discovery lines of the $home home', async ({ home: variant, discovery }) => {
    // Arrange
    const home = await harness.createHome({ home: variant })

    // Act
    const host = await harness.startHost(home, { args: ['--no-open', '--no-sync'] })
    const labelling = await lineStarting(host, 'Labelling    ')
    const root = await fetch(host.url)
    await host.stop()

    // Assert
    const { stdout } = host.output()
    const from = stdout.indexOf(warehouseLine(home))
    const to = stdout.findIndex((line) => line.startsWith('Log Book is running at '))
    expect({
      lines: lineDifferences(stdout.slice(from, to + 1), [warehouseLine(home), ...discovery, URL_LINE]),
      labelling,
      root: root.status,
    }).toStrictEqual({ lines: [], labelling: LABELLING_MISSING, root: 200 })
  })

  it('stops at once on SIGINT during its first sync, and the next sync continues from what it kept', async ({
    annotate,
  }) => {
    // Arrange
    const home = await harness.createHome()
    const { sessions } = counts()
    const host = await harness.startHost(home, { args: ['--no-open'] })
    await vi.waitFor(
      () => {
        if (!host.output().stderr.some((line) => line.trimStart().startsWith('Claude Code'))) {
          throw new Error('the first sync has printed no progress line yet')
        }
      },
      { timeout: FIRST_SYNC_TIMEOUT_MS, interval: 10 }
    )

    // Act
    const sentAt = performance.now()
    const code = await host.stop()
    const ms = Math.round(performance.now() - sentAt)
    await annotate(`the host stopped ${String(ms)} ms after SIGINT`)
    const left = [`${warehouseOf(home)}.host`, `${warehouseOf(home)}.lock`].filter((file) => existsSync(file))
    const [newest] = read<{ isEnded: number }>(
      warehouseOf(home),
      'SELECT ended_at IS NOT NULL AS isEnded FROM sync_run ORDER BY id DESC LIMIT 1'
    )
    const sync = await harness.run(home, ['sync'])

    // Assert
    expect({
      code,
      isWithinBound: ms < STOP_BOUND_MS,
      left,
      newest,
      sync: sync.code,
      sessions: read<{ sessions: number; ids: number }>(
        warehouseOf(home),
        'SELECT count(*) AS sessions, count(DISTINCT id) AS ids FROM session'
      )[0],
    }).toStrictEqual({
      code: 0,
      isWithinBound: true,
      left: [],
      newest: { isEnded: 1 },
      sync: 0,
      sessions: { sessions, ids: sessions },
    })
  })

  it("reports a partial first sync and a scheduled one, each with its problem and its log's path", async () => {
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
    const shown = `~/${OPENCODE_DATABASE}`
    const problem = `OpenCode: cannot read ${shown}: Cannot open ${shown}: ${reason}`
    const { claudeCodeUnits } = counts()

    // Act
    const host = await harness.startHost(home, { args: ['--no-open', '--interval', '1'] })
    const done = await lineStarting(host, 'First sync   done in ')
    const [firstLog] = await logNames(home)
    const scheduled = await vi.waitFor(
      () => {
        const line = host.output().stdout.find((candidate) => SCHEDULED_LINE.test(candidate))
        if (line === undefined) {
          throw new Error('no scheduled sync line yet')
        }
        return line
      },
      { timeout: SCHEDULED_SYNC_TIMEOUT_MS, interval: 200 }
    )
    const logs = await logNames(home)

    // Assert
    const { stdout } = host.output()
    const secondLog = logs.find((name) => name !== firstLog) ?? ''
    // A scheduled line names the minute its sync ended; its log, the second it started.
    const started = /T(?<hours>\d{2})-(?<minutes>\d{2})-/u.exec(secondLog)?.groups
    const startedMinute = Number(started?.hours) * 60 + Number(started?.minutes)
    const printedMinute = Number(scheduled.slice(0, 2)) * 60 + Number(scheduled.slice(3, 5))
    expect({
      done: lineDifferences(stdout.slice(stdout.indexOf(done), stdout.indexOf(done) + 2), [
        `First sync   done in {duration}: ${String(claudeCodeUnits)} sessions, with 1 problem: ${problem}`,
        `             Full output: ~/${LOGS}/${firstLog ?? ''}`,
      ]),
      scheduled: lineDifferences(
        [scheduled.slice(6)],
        [`sync: 0 sessions updated in {duration}, with 1 problem: ${problem}. Full output: ~/${LOGS}/${secondLog}`]
      ),
      isMinuteOfItsSync: printedMinute === startedMinute || printedMinute === (startedMinute + 1) % (24 * 60),
    }).toStrictEqual({ done: [], scheduled: [], isMinuteOfItsSync: true })
  }, 180_000)
})
