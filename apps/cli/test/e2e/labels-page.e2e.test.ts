import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { openSqlite } from '@log-book/core'
import { installFakeClaude, type IFakeClaude, type IFakeClaudeRecord } from '@log-book/engine/testing'
import { takeLabelsLock, type IHeldLock } from '@log-book/warehouse'
import { afterEach, describe, expect, inject, it, vi } from 'vitest'
import { useE2eHarness, type IE2eHome, type IStartedHost } from './harness.js'

// What the labelling page promises, through the binary, with the recorded claude fake first on the host's PATH: the
// real plan before anything is sent, Start and Stop on a child of the host, progress read from the warehouse, and no
// run started for another site or signal sent to a process the host did not start.
const harness = useE2eHarness()
const run = promisify(execFile)

const HOST_ARGS = ['--no-open', '--no-sync']
const DEFAULT_MODEL = 'claude-haiku-4-5'
const FORM = 'application/x-www-form-urlencoded'
const EVIL_ORIGIN = 'http://evil.example'
const FORGET_LINE = 'Labelling waits: logbook forget is removing sessions (since 1 min).'
const DETECTION_CALLS = [['--version'], ['auth', 'status', '--json']]
const POLL_MS = 200
const RUN_TIMEOUT_MS = 60_000
const FLOW_TIMEOUT_MS = 150_000
// The heading the reply task puts before the reply it labels, so a marker that starts with it is in a reply batch
// only: every other task that quotes a reply quotes it as context.
const REPLY_HEADING = '[THE REPLY] '
const MARKER_LENGTH = 20

// Each task's batch, by its system line and, for the four tasks that share one, the code table its prompt holds.
const TASKS = [
  { task: 'shell', system: 'You label shell commands', includes: undefined, answer: '0 0' },
  { task: 'tool-failure', system: 'You label failed tool calls', includes: undefined, answer: '0' },
  { task: 'session', system: 'You label conversations', includes: 'secondGoal codes:', answer: '0 0 | added a field' },
  { task: 'outcome', system: 'You label conversations', includes: 'outcome codes:', answer: '0 | done' },
  { task: 'prompt', system: 'You label conversations', includes: 'act codes:', answer: '0' },
  { task: 'reply', system: 'You label conversations', includes: 'reply codes:', answer: '0 | -' },
] as const

interface IPlanFacts {
  tasks: { task: string; records: number }[]
  records: number
}

interface ILabelling {
  home: IE2eHome
  host: IStartedHost
  fake: IFakeClaude
  // Where the test lets the held batch go on.
  release: string
  marker: string
}

// Processes the test keeps alive, so a lock that names one is held by a live process the host did not start.
const holders: ChildProcess[] = []
const locks: IHeldLock[] = []

afterEach(async () => {
  for (const lock of locks.splice(0)) {
    lock.release()
  }
  await Promise.all(
    holders.splice(0).map(async (holder) => {
      const exited = once(holder, 'exit')
      holder.kill()
      await exited
    })
  )
})

const warehouseOf = (home: IE2eHome): string => home.environment.LOGBOOK_DB ?? ''

// The start of a reply of an interactive session of the small set that no other reply starts with, as the reply task
// shows it: a record the test marks, so the one batch that holds it waits for the release file.
const markedReply = (): string => {
  const starts = inject('e2eDemo')
    .plan.writers.flatMap((writer) => writer.scripts)
    .filter((script) => !script.isScripted)
    .flatMap((script) => script.steps)
    .flatMap((step) =>
      step.kind === 'reply' &&
      typeof step.text === 'string' &&
      step.text.length >= MARKER_LENGTH &&
      !step.text.includes('\n')
        ? [step.text.slice(0, MARKER_LENGTH)]
        : []
    )
  const start = starts.find((candidate) => starts.indexOf(candidate) === starts.lastIndexOf(candidate))
  if (start === undefined) {
    throw new Error('the small set has no single-line reply whose start no other reply shares')
  }
  return `${REPLY_HEADING}${start}`
}

// A copy of the small home with no warehouse, synced once so every record waits for a model label, and a host on it
// with the fake first on its PATH, once the host has looked for labelling.
const labelling = async (): Promise<ILabelling> => {
  const home = await harness.createHome()
  const sync = await harness.run(home, ['sync'])
  if (sync.code !== 0) {
    throw new Error(`logbook sync exited ${String(sync.code)}: ${sync.stderr.join(' | ')}`)
  }
  const bin = join(home.out, 'claude-bin')
  await mkdir(bin)
  const release = join(home.out, 'release-held-batch')
  const marker = markedReply()
  const fake = await installFakeClaude(bin, {
    answers: TASKS.map(({ system, includes, answer }) => ({
      systemPrompt: system,
      answer,
      ...(includes === undefined ? {} : { promptIncludes: includes }),
    })),
    rules: [{ marker, kind: 'hold', file: release }],
  })
  const host = await harness.startHost(home, { args: HOST_ARGS, firstOnPath: bin })
  await vi.waitFor(
    () => {
      if (!host.output().stdout.some((line) => line.startsWith('Labelling    '))) {
        throw new Error('the host has not looked for labelling yet')
      }
    },
    { timeout: RUN_TIMEOUT_MS, interval: POLL_MS }
  )
  return { home, host, fake, release, marker }
}

const query = async <TRow>(home: IE2eHome, sql: string): Promise<TRow[]> => {
  const db = await openSqlite(warehouseOf(home), { isReadOnly: true })
  try {
    return (db.prepare(sql).all() as object[]).map((row) => ({ ...row }) as TRow)
  } finally {
    db.close()
  }
}

const labelRuns = async (
  home: IE2eHome
): Promise<{ id: number; pid: number; model: string; outcome: string | null }[]> =>
  query(home, 'SELECT id, pid, model, outcome FROM label_run ORDER BY id')

const post = async (
  host: IStartedHost,
  path: string,
  body: string,
  origin: string | null = host.url
): Promise<Response> =>
  fetch(`${host.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': FORM, ...(origin === null ? {} : { Origin: origin }) },
    body,
    redirect: 'manual',
  })

const page = async (host: IStartedHost): Promise<{ status: number; body: string }> => {
  const response = await fetch(`${host.url}/labels`)
  return { status: response.status, body: await response.text() }
}

const isPrint = (record: IFakeClaudeRecord): boolean => record.argv.includes('-p')

const taskOf = (record: IFakeClaudeRecord): string | undefined => {
  const system = record.argv[record.argv.indexOf('--system-prompt') + 1] ?? ''
  return TASKS.find(
    (task) => system.startsWith(task.system) && (task.includes === undefined || record.stdin.includes(task.includes))
  )?.task
}

const itemsOf = (record: IFakeClaudeRecord): number => (record.stdin.match(/^### #\d+$/gmu) ?? []).length

// The records of the calls the fake holds: every call carrying the marker, none of them answered yet.
const heldItems = async (setup: ILabelling): Promise<number> =>
  (await setup.fake.readRecords())
    .filter((record) => record.stdin.includes(setup.marker))
    .reduce((total, record) => total + itemsOf(record), 0)

const isChildOf = async (pid: number, parent: number): Promise<boolean> =>
  Number((await run('ps', ['-o', 'ppid=', '-p', String(pid)])).stdout.trim()) === parent

const progressOf = (body: string): { done: number; planned: number } | undefined => {
  const groups = /: (?<done>[\d,]+) of (?<planned>[\d,]+) records? \(/u.exec(body)?.groups
  return groups === undefined
    ? undefined
    : { done: Number(groups.done?.replaceAll(',', '')), planned: Number(groups.planned?.replaceAll(',', '')) }
}

const endedRun = async (home: IE2eHome, id: number): Promise<string> =>
  vi.waitFor(
    async () => {
      const [ended] = await query<{ outcome: string | null }>(
        home,
        `SELECT outcome FROM label_run WHERE id = ${String(id)} AND ended_at IS NOT NULL`
      )
      if (ended?.outcome === undefined || ended.outcome === null) {
        throw new Error(`label run ${String(id)} has not ended yet`)
      }
      return ended.outcome
    },
    { timeout: RUN_TIMEOUT_MS, interval: POLL_MS }
  )

const newRun = async (home: IE2eHome, after: number): Promise<{ id: number; pid: number; model: string }> =>
  vi.waitFor(
    async () => {
      const added = (await labelRuns(home)).find((row) => row.id > after)
      if (added === undefined) {
        throw new Error('no new label run yet')
      }
      return { id: added.id, pid: added.pid, model: added.model }
    },
    { timeout: RUN_TIMEOUT_MS, interval: POLL_MS }
  )

const stopTheRun = async (setup: ILabelling, id: number): Promise<void> => {
  await post(setup.host, '/labels/stop', 'back=%2Flabels')
  await endedRun(setup.home, id)
}

// A live process the test started, named by the labelling lock as `operation`.
const holdLabelsLock = (home: IE2eHome, operation: 'labels' | 'forget'): ChildProcess => {
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
  holders.push(holder)
  locks.push(takeLabelsLock(warehouseOf(home), operation, { pid: holder.pid ?? 0 }))
  return holder
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('labelling from /labels against a running host', () => {
  it('refuses POST /labels from another origin: no run and no claude -p call', async () => {
    // Arrange
    const setup = await labelling()

    // Act
    const response = await post(setup.host, '/labels', `model=${DEFAULT_MODEL}`, EVIL_ORIGIN)

    // Assert
    expect({
      status: response.status,
      runs: await labelRuns(setup.home),
      prints: (await setup.fake.readRecords()).filter((record) => isPrint(record)).length,
    }).toStrictEqual({ status: 403, runs: [], prints: 0 })
  })

  it('shows the plan logbook labels plan prints, sending nothing, then Start runs a child of the host', async () => {
    // Arrange
    const setup = await labelling()
    const callsBefore = (await setup.fake.readRecords()).length

    // Act
    const shown = await page(setup.host)
    const callsWhileShown = (await setup.fake.readRecords()).slice(callsBefore).map((record) => record.argv)
    const plan = await harness.run(setup.home, ['labels', 'plan'], { firstOnPath: join(setup.home.out, 'claude-bin') })
    const started = await post(setup.host, '/labels', `model=${DEFAULT_MODEL}`)
    const added = await newRun(setup.home, 0)
    const isHostChild = await isChildOf(added.pid, setup.host.pid)
    await stopTheRun(setup, added.id)

    // Assert
    const facts = JSON.parse(plan.stdout.join('\n')) as IPlanFacts
    expect({
      status: shown.status,
      isPlanShown: shown.body.includes(`To label: ${facts.records.toLocaleString('en-US')} records (`),
      callsWhileShown,
      started: { status: started.status, location: started.headers.get('location') },
      run: { model: added.model, isHostChild },
    }).toStrictEqual({
      status: 200,
      isPlanShown: true,
      callsWhileShown: DETECTION_CALLS,
      started: { status: 303, location: '/labels' },
      run: { model: DEFAULT_MODEL, isHostChild: true },
    })
  })

  it('answers 400 to a model that is a flag, starting no run', async () => {
    // Arrange
    const setup = await labelling()

    // Act
    const response = await post(setup.host, '/labels', 'model=--help')

    // Assert
    expect({ status: response.status, runs: await labelRuns(setup.home) }).toStrictEqual({ status: 400, runs: [] })
  })

  it('signals no process it did not start, and plans and starts nothing while a forget holds the lock', async () => {
    // Arrange
    const setup = await labelling()
    const holder = holdLabelsLock(setup.home, 'labels')

    // Act
    const stop = await post(setup.host, '/labels/stop', 'back=%2Flabels')
    const isHolderAlive = isAlive(holder.pid ?? 0)
    locks.splice(0).forEach((lock) => {
      lock.release()
    })
    holdLabelsLock(setup.home, 'forget')
    const callsBefore = (await setup.fake.readRecords()).length
    const shown = await page(setup.host)
    const callsWhileShown = (await setup.fake.readRecords()).length - callsBefore
    const started = await post(setup.host, '/labels', `model=${DEFAULT_MODEL}`)

    // Assert
    expect({
      stop: stop.status,
      isHolderAlive,
      shown: {
        status: shown.status,
        isForgetLine: shown.body.includes(`<p class="labels__line">${FORGET_LINE}</p>`),
        forms: ['action="/labels"', 'action="/labels/stop"'].filter((form) => shown.body.includes(form)),
      },
      callsWhileShown,
      started: started.status,
      runs: await labelRuns(setup.home),
    }).toStrictEqual({
      stop: 303,
      isHolderAlive: true,
      shown: { status: 200, isForgetLine: true, forms: [] },
      callsWhileShown: 0,
      started: 303,
      runs: [],
    })
  })

  it(
    'shows progress on reload, stops keeping every finished batch, and labels only the held batch on the next Start',
    async () => {
      // Arrange
      const setup = await labelling()

      // Act
      await post(setup.host, '/labels', `model=${DEFAULT_MODEL}`)
      const first = await newRun(setup.home, 0)
      const reloaded = await vi.waitFor(
        async () => {
          const shown = await page(setup.host)
          const [progress, held] = [progressOf(shown.body), await heldItems(setup)]
          if (progress === undefined || held === 0 || progress.done !== progress.planned - held) {
            throw new Error(`the page shows ${JSON.stringify(progress)} with ${String(held)} records held`)
          }
          return { held, isStopShown: shown.body.includes('action="/labels/stop"') }
        },
        { timeout: RUN_TIMEOUT_MS, interval: POLL_MS }
      )
      await post(setup.host, '/labels/stop', 'back=%2Flabels')
      const stopped = await endedRun(setup.home, first.id)
      // The plan part shows once the run's child has exited, which releases the lock as it goes.
      await vi.waitFor(
        async () => {
          if (!(await page(setup.host)).body.includes('data-labels-part="plan"')) {
            throw new Error('the page does not show the plan again yet')
          }
        },
        { timeout: RUN_TIMEOUT_MS, interval: POLL_MS }
      )
      const isLockLeft = existsSync(`${warehouseOf(setup.home)}.labels.lock`)
      const plan = await harness.run(setup.home, ['labels', 'plan'], {
        firstOnPath: join(setup.home.out, 'claude-bin'),
      })
      await writeFile(setup.release, '')
      const callsBefore = (await setup.fake.readRecords()).length
      await post(setup.host, '/labels', `model=${DEFAULT_MODEL}`)
      const second = await newRun(setup.home, first.id)
      const secondOutcome = await endedRun(setup.home, second.id)
      const secondCalls = (await setup.fake.readRecords()).slice(callsBefore).filter((record) => isPrint(record))

      // Assert
      const facts = JSON.parse(plan.stdout.join('\n')) as IPlanFacts
      expect({
        isStopShown: reloaded.isStopShown,
        stopped,
        isLockLeft,
        left: facts.tasks.filter(({ records }) => records > 0),
        second: {
          outcome: secondOutcome,
          tasks: [...new Set(secondCalls.map((record) => taskOf(record)))],
          items: secondCalls.reduce((total, record) => total + itemsOf(record), 0),
        },
      }).toStrictEqual({
        isStopShown: true,
        stopped: 'stopped',
        isLockLeft: false,
        left: [{ task: 'reply', records: reloaded.held }],
        second: { outcome: 'ok', tasks: ['reply'], items: reloaded.held },
      })
    },
    FLOW_TIMEOUT_MS
  )
})
