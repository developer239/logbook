import { spawn, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ERROR_CODES } from '@log-book/core'
import { readLabelsLock, readSyncLock, takeLabelsLock, WarehouseLockHeldError } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installFakeClaude,
  typeScriptChildArgs,
  type FakeClaudeRule,
  type IFakeClaude,
  type IFakeClaudeScenario,
} from '../testing/index.js'
import { runLabelling, type ILabelRunOptions, type ILabelRunReport, type LabelRunResult } from './label-run.js'
import versions from './tasks/versions.json' with { type: 'json' }

const CHILD_TIMEOUT_MS = 20_000
const ENDED_TIMEOUT_MS = 5_000
const POLL_MS = 50
const SESSION = 'test-harness:main'
const SHELL_SYSTEM = 'You label shell commands'

type TRow = Record<string, string | number | null>

const callId = (index: number): string => `c${String(index).padStart(2, '0')}`

const shellCall = (index: number): [string, TRow] => [
  'tool_call',
  {
    id: callId(index),
    session_id: SESSION,
    message_id: `${SESSION}/m1`,
    name: 'Bash',
    bare_name: 'Bash',
    family: 'shell',
    input_json: JSON.stringify({ command: `ls ${callId(index)}` }),
    status: 'ok',
  },
]

const failedRead = (id: string): [string, TRow][] => [
  [
    'tool_call',
    {
      id,
      session_id: SESSION,
      message_id: `${SESSION}/m1`,
      name: 'Read',
      bare_name: 'Read',
      family: 'read',
      input_json: '{}',
      status: 'error',
    },
  ],
  [
    'part',
    {
      message_id: `${SESSION}/m1`,
      session_id: SESSION,
      idx: Number(id.slice(1)),
      kind: 'tool_result',
      text: `File ${id} does not exist.`,
      tool_call_id: id,
    },
  ],
]

const SESSION_ROWS: [string, TRow][] = [
  [
    'harness',
    {
      id: 'test-harness',
      name: 'Test Harness',
      default_agent: 'build',
      filter_alias: 'test',
      is_found: 1,
      checked_at: 1,
      location_variables: '[]',
    },
  ],
  [
    'session',
    { id: SESSION, harness: 'test-harness', source_id: 'main', origin: 'scripted', is_scripted: 1, started_at: 1 },
  ],
]

const ANSWERS: IFakeClaudeScenario['answers'] = [
  { systemPrompt: SHELL_SYSTEM, answer: '0 0' },
  { systemPrompt: 'You label failed tool calls', answer: '0' },
  { systemPrompt: 'You label conversations', promptIncludes: 'secondGoal codes:', answer: '0 0 | read the cart' },
  { systemPrompt: 'You label conversations', promptIncludes: 'outcome codes:', answer: '0 | done' },
]

// Runs a labels update the parent's SIGTERM stops, and prints its result.
const LABELLING_CHILD = `const [runUrl, warehousePath] = process.argv.slice(2)
const { runLabelling } = await import(runUrl)
const controller = new AbortController()
process.on('SIGTERM', () => controller.abort(new Error('SIGTERM')))
const result = await runLabelling({ warehousePath, scope: { kind: 'update' }, signal: controller.signal, concurrency: 1 })
process.stdout.write(JSON.stringify(result))
`

// Holds the warehouse's locks as a compaction or a forget does, through the rewrite modules.
const HOLDING_CHILD = `const [operation, moduleUrl, warehousePath, sessionId] = process.argv.slice(2)
const module = await import(moduleUrl)
const signal = new AbortController().signal
const result =
  operation === 'compact'
    ? await module.runCompact({ warehousePath, signal, onProgress: () => {} })
    : await module.runForget({ warehousePath, target: { sessions: [sessionId] }, signal, onProgress: () => {} })
process.stdout.write(result.outcome)
`

// The argument vectors of the fake's `claude -p` calls, without the detection calls.
const printCalls = async (fake: IFakeClaude): Promise<string[][]> =>
  (await fake.readRecords()).filter(({ argv }) => argv.includes('-p')).map(({ argv }) => argv)

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The processes that are still running after the time allowed for them to end, killed so a failure here leaks none.
const survivorsOf = async (pids: readonly number[]): Promise<number[]> => {
  await vi
    .waitFor(
      () => {
        expect(pids.filter(isRunning)).toStrictEqual([])
      },
      { timeout: ENDED_TIMEOUT_MS, interval: POLL_MS }
    )
    .catch(() => undefined)
  const survivors = pids.filter(isRunning)
  for (const pid of survivors) {
    process.kill(pid, 'SIGKILL')
  }
  return survivors
}

describe('runLabelling', () => {
  let home = ''
  let warehouse: ITestWarehouse | null = null

  const opened = (): ITestWarehouse => {
    if (warehouse === null) {
      throw new Error('The warehouse is not open.')
    }
    return warehouse
  }

  const arrange = (rows: readonly [string, TRow][]): void => {
    for (const [table, row] of rows) {
      insert(opened().db, table, row)
    }
  }

  const install = async (rules: FakeClaudeRule[] = [], scenario: IFakeClaudeScenario = {}): Promise<IFakeClaude> => {
    const bin = await mkdtemp(join(home, 'bin-'))
    vi.stubEnv('PATH', bin)
    return installFakeClaude(bin, { answers: ANSWERS, rules, ...scenario })
  }

  const label = async (options: Partial<ILabelRunOptions> = {}): Promise<LabelRunResult> =>
    runLabelling({
      warehousePath: opened().path,
      scope: { kind: 'update' },
      signal: new AbortController().signal,
      concurrency: 1,
      ...options,
    })

  const ran = async (options: Partial<ILabelRunOptions> = {}): Promise<ILabelRunReport> => {
    const result = await label(options)
    if (result.status !== 'ran') {
      throw new Error(`The run did not start: ${JSON.stringify(result)}`)
    }
    return result
  }

  const rows = <TRow>(sql: string, ...params: string[]): TRow[] =>
    (
      opened()
        .db.prepare(sql)
        .all(...params) as object[]
    ).map((row) => ({ ...row }) as TRow)

  const runRecords = (): {
    pid: number
    outcome: string | null
    error: string | null
    isEnded: boolean
    model: string
  }[] =>
    rows<{ pid: number; outcome: string | null; error: string | null; ended_at: number | null; model: string }>(
      'SELECT pid, outcome, error, ended_at, model FROM label_run ORDER BY id'
    ).map(({ ended_at: endedAt, ...row }) => ({ ...row, isEnded: endedAt !== null }))

  // A child script with the loader for the sources, its stdout and its close.
  const child = async (script: string, args: string[]): Promise<{ pid: number; closed: Promise<string> }> => {
    const file = join(home, `child-${String(Date.now())}.mjs`)
    await writeFile(file, script)
    const running = spawn(process.execPath, [...(await typeScriptChildArgs(home)), file, ...args], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    running.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    return { pid: running.pid ?? 0, closed: new Promise((resolve) => running.on('close', () => resolve(stdout))) }
  }

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'log-book-label-run-')))
    vi.stubEnv('HOME', home)
    vi.stubEnv('CLAUDE_BIN', '')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    warehouse = await createTestWarehouse()
    arrange(SESSION_ROWS)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await warehouse?.remove()
    warehouse = null
    await rm(home, { recursive: true, force: true })
  })

  it.each([
    ['without a model', undefined, 'claude-haiku-4-5'],
    ['with claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'],
  ])(
    'labels %s with that literal id in every call, row and the preflight, at the versions of versions.json',
    async (_case, model, id) => {
      // Arrange
      arrange([shellCall(0), shellCall(1)])
      const fake = await install()
      let preflightModel = ''

      // Act
      await ran({ ...(model === undefined ? {} : { model }), onPreflight: (facts) => (preflightModel = facts.model) })

      // Assert
      expect({
        preflightModel,
        callModels: [
          ...new Set(
            (await fake.readRecords()).filter(({ argv }) => argv.includes('-p')).map((record) => record.model)
          ),
        ],
        labels: rows('SELECT DISTINCT labeller, version FROM label'),
        tasks: rows('SELECT task, version FROM label_run_task ORDER BY task'),
      }).toStrictEqual({
        preflightModel: id,
        callModels: [id],
        labels: [{ labeller: id, version: versions.shell }],
        tasks: Object.entries(versions)
          .map(([task, version]) => ({ task, version }))
          .toSorted((left, right) => (left.task < right.task ? -1 : 1)),
      })
    }
  )

  it.each(['', 'claude haiku', '-x'])(
    'refuses the model %j before any claude process, writing no record',
    async (model) => {
      // Arrange
      arrange([shellCall(0)])
      const fake = await install()

      // Act
      const labelling = label({ model })

      // Assert
      await expect(labelling).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR })
      expect({ calls: await fake.readRecords(), records: runRecords() }).toStrictEqual({ calls: [], records: [] })
    }
  )

  it('writes no record when detection finds Claude Code signed out', async () => {
    // Arrange
    arrange([shellCall(0)])
    await install([], { auth: { loggedIn: false } })

    // Act
    const result = await label()

    // Assert
    expect({ result, records: runRecords() }).toStrictEqual({
      result: { status: 'missing', missing: { kind: 'not-signed-in' } },
      records: [],
    })
  })

  it("writes the record after the preflight and before the first call, recounts a task's planned as it starts, and keeps done equal to the labels", async () => {
    // Arrange
    arrange([shellCall(0), shellCall(1)])
    const release = join(home, 'release')
    const fake = await install([{ marker: 'ls c00', kind: 'hold', file: release }])
    const seen: { recordsAtPreflight: number; doneAndLabels: number[][] } = {
      recordsAtPreflight: -1,
      doneAndLabels: [],
    }

    // Act
    const running = ran({
      onPreflight: () => {
        seen.recordsAtPreflight = runRecords().length
      },
      onProgress: (progress) => {
        const done =
          rows<{ done: number }>('SELECT done FROM label_run_task WHERE task = ?', progress.task)[0]?.done ?? -1
        const labelled =
          rows<{ count: number }>(
            "SELECT count(DISTINCT record_id) AS count FROM label WHERE name IN ('purpose', 'cause')"
          )[0]?.count ?? -1
        seen.doneAndLabels.push([done, labelled])
      },
    })
    await vi.waitFor(async () => expect(await printCalls(fake)).toHaveLength(1), { timeout: CHILD_TIMEOUT_MS })
    const whileHeld = { records: runRecords(), lockPid: readLabelsLock(opened().path).pid }
    arrange(failedRead('c9'))
    await writeFile(release, '')
    const result = await running

    // Assert
    expect({
      recordsAtPreflight: seen.recordsAtPreflight,
      whileHeld,
      planned: rows(
        'SELECT task, planned, done FROM label_run_task WHERE task IN (?, ?) ORDER BY task',
        'shell',
        'tool-failure'
      ),
      doneAndLabels: seen.doneAndLabels,
      outcome: result.outcome,
    }).toStrictEqual({
      recordsAtPreflight: 0,
      whileHeld: {
        records: [{ pid: process.pid, outcome: null, error: null, isEnded: false, model: 'claude-haiku-4-5' }],
        lockPid: process.pid,
      },
      planned: [
        { task: 'shell', planned: 2, done: 2 },
        { task: 'tool-failure', planned: 1, done: 1 },
      ],
      doneAndLabels: [
        [2, 2],
        [1, 3],
      ],
      outcome: 'ok',
    })
  })

  it.each([
    ['SIGTERM', { outcome: 'stopped', isEnded: true }],
    ['SIGKILL', { outcome: null, isEnded: false }],
  ] as const)(
    'leaves the record as it must be after %s during the second of three tasks, the lock free',
    async (signal, expected) => {
      // Arrange
      arrange([shellCall(0), ...failedRead('c9')])
      arrange([
        [
          'message',
          { id: `${SESSION}/m0`, session_id: SESSION, seq: 0, actor: 'user', source_role: 'user', created_at: 1 },
        ],
        ['part', { message_id: `${SESSION}/m0`, session_id: SESSION, idx: 0, kind: 'text', text: 'read the cart' }],
      ])
      const fake = await install([{ marker: 'File c9 does not exist.', kind: 'hold', file: join(home, 'never') }])
      const running = await child(LABELLING_CHILD, [new URL('label-run.ts', import.meta.url).href, opened().path])
      await vi.waitFor(async () => expect(await printCalls(fake)).toHaveLength(2), { timeout: CHILD_TIMEOUT_MS })

      const claudePids = (await fake.readRecords()).filter(({ argv }) => argv.includes('-p')).map(({ pid }) => pid)

      // Act
      process.kill(running.pid, signal)
      await running.closed
      const survivors = await survivorsOf(claudePids)

      // Assert
      const [record] = runRecords()
      expect({
        outcome: record?.outcome,
        isEnded: record?.isEnded,
        isLockHeld: readLabelsLock(opened().path).isHeld,
        survivors,
      }).toStrictEqual({
        ...expected,
        isLockHeld: false,
        survivors: [],
      })
    },
    CHILD_TIMEOUT_MS
  )

  it('ends a run with nothing pending at once with ok', async () => {
    // Arrange
    const fake = await install()

    // Act
    const result = await ran()

    // Assert
    expect({ outcome: result.outcome, records: runRecords(), calls: await printCalls(fake) }).toStrictEqual({
      outcome: 'ok',
      records: [{ pid: process.pid, outcome: 'ok', error: null, isEnded: true, model: 'claude-haiku-4-5' }],
      calls: [],
    })
  })

  it('keeps the batches before a usage limit, starts no later task, and resumes with the rest', async () => {
    // Arrange
    arrange([...Array.from({ length: 30 }, (_call, index) => shellCall(index)), ...failedRead('c99')])
    const limited = await install([{ marker: 'ls c29', kind: 'envelope', envelope: 'usage-limit' }])
    const first = await ran()
    const resumed = await install()

    // Act
    const next = await ran()

    // Assert
    expect({
      first: { outcome: first.outcome, done: first.totals.done, calls: (await printCalls(limited)).length },
      error: runRecords()[0]?.error,
      next: next.tasks.filter(({ planned }) => planned > 0).map(({ task, planned }) => ({ task, planned })),
      isResumedPromptOnlyTheRest: (await resumed.readRecords()).every(({ stdin }) => !stdin.includes('ls c00')),
    }).toStrictEqual({
      first: { outcome: 'limit', done: 25, calls: 2 },
      error: expect.stringMatching(
        /^Stopped at your Claude usage limit \(API Error: Server is temporarily limiting requests/u
      ) as string,
      next: [
        { task: 'shell', planned: 5 },
        { task: 'tool-failure', planned: 1 },
      ],
      isResumedPromptOnlyTheRest: true,
    })
  })

  it.each([
    [
      'api-unreachable',
      { outcome: 'unreachable', failureKind: null },
      /^Labelling stopped: Claude Code could not reach its API \(/u,
    ],
    ['auth-refused', { outcome: 'failed', failureKind: 'not-signed-in' }, /^Claude Code is not signed in \(/u],
  ] as const)('ends at %s with its outcome, keeping the batch in flight', async (envelope, expected, error) => {
    // Arrange
    arrange(Array.from({ length: 30 }, (_call, index) => shellCall(index)))
    await install([
      { marker: 'ls c29', kind: 'envelope', envelope },
      { marker: 'ls c01', kind: 'delay', ms: 400 },
    ])

    // Act
    const result = await ran({ concurrency: 2 })

    // Assert
    expect({
      outcome: result.outcome,
      failureKind: result.failureKind,
      done: result.totals.done,
      error: result.error,
    }).toStrictEqual({
      ...expected,
      done: 25,
      error: expect.stringMatching(error) as string,
    })
  })

  it('stores a failure text naming a path under the home in the ~/ form', async () => {
    // Arrange
    arrange([shellCall(0)])
    const fake = await install()

    // Act
    const result = await ran({
      onPreflight: () => {
        rmSync(fake.path)
      },
    })

    // Assert
    const [record] = runRecords()
    expect({
      outcome: result.outcome,
      failureKind: result.failureKind,
      isTilde: record?.error?.includes(`~/${fake.path.slice(home.length + 1)}`),
      hasHome: record?.error?.includes(home),
    }).toStrictEqual({
      outcome: 'failed',
      failureKind: 'not-found',
      isTilde: true,
      hasHome: false,
    })
  })

  it('refuses a second run at once as already running, and takes over a lock naming a dead pid', async () => {
    // Arrange
    arrange([shellCall(0)])
    const release = join(home, 'release')
    const fake = await install([{ marker: 'ls c00', kind: 'hold', file: release }])
    const first = ran()
    await vi.waitFor(async () => expect(await printCalls(fake)).toHaveLength(1), { timeout: CHILD_TIMEOUT_MS })

    // Act
    const second = label()
    await expect(second).rejects.toBeInstanceOf(WarehouseLockHeldError)
    await expect(second).rejects.toMatchObject({ operation: 'labels', pid: process.pid })
    const recordsWhileHeld = runRecords().length
    await writeFile(release, '')
    await first
    // A pid that has ended: a Node process that exits at once.
    takeLabelsLock(opened().path, 'labels', { pid: spawnSync(process.execPath, ['-e', '']).pid })
    const takenOver = await ran()

    // Assert
    expect({ recordsWhileHeld, takenOver: takenOver.outcome, records: runRecords().length }).toStrictEqual({
      recordsWhileHeld: 1,
      takenOver: 'ok',
      records: 2,
    })
  })

  it.each([
    ['compact', '../rewrite/compact.ts'],
    ['forget', '../rewrite/forget.ts'],
  ])(
    'is refused while %s holds both locks, naming its holder, with no record and no claude -p',
    async (operation, module) => {
      // Arrange
      arrange([shellCall(0)])
      const fake = await install()
      opened().db.exec('PRAGMA journal_mode = WAL')
      opened().db.exec('BEGIN IMMEDIATE')
      const holder = await child(HOLDING_CHILD, [
        operation,
        new URL(module, import.meta.url).href,
        opened().path,
        SESSION,
      ])
      await vi.waitFor(
        () => {
          expect([readSyncLock(opened().path).pid, readLabelsLock(opened().path).pid]).toStrictEqual([
            holder.pid,
            holder.pid,
          ])
        },
        { timeout: CHILD_TIMEOUT_MS }
      )

      // Act
      const labelling = label()
      await expect(labelling).rejects.toMatchObject({ operation, pid: holder.pid })
      opened().db.exec('COMMIT')
      const outcome = await holder.closed

      // Assert
      expect({ records: runRecords(), calls: await printCalls(fake), holder: outcome }).toStrictEqual({
        records: [],
        calls: [],
        holder: 'ok',
      })
    },
    CHILD_TIMEOUT_MS
  )
})
