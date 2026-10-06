import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Errors from './errors'
import type * as Labelling from './labelling'
import { logbookStub, type ILogbookStub } from './testing/logbook-stub'

// Invented counts, in the shape `logbook labels plan` prints.
const PLAN = {
  model: 'claude-haiku-4-5',
  claudeVersion: '2.1.290',
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  apiKeyInEnvironment: false,
  tasks: [
    { task: 'shell', records: 2140 },
    { task: 'tool-failure', records: 0 },
    { task: 'session', records: 12 },
    { task: 'outcome', records: 9 },
    { task: 'prompt', records: 31 },
    { task: 'reply', records: 22 },
  ],
  harnesses: [
    { id: 'example', name: 'Example Harness', records: 1630 },
    { id: 'sample', name: 'Sample Harness', records: 584 },
  ],
  records: 2214,
  estimatedInputTokens: 560_000,
}

let directory = ''
let stub: ILogbookStub
let labelling: typeof Labelling
let errors: typeof Errors

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'web-labelling-'))
  stub = await logbookStub(directory)
  // The module keeps this process's children, so each case starts with none.
  vi.resetModules()
  labelling = await import('./labelling')
  errors = await import('./errors')
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

describe('the plan', () => {
  it('runs one child for two plans requested at once, and reads the plan it prints', async () => {
    // Arrange
    stub.answer(0, [], { stdout: `${JSON.stringify(PLAN)}\n` })

    // Act
    const [first, second] = await Promise.all([labelling.plan(null), labelling.plan(null)])

    // Assert
    expect({ first, isJoined: first === second, calls: await stub.calls() }).toStrictEqual({
      first: { kind: 'plan', plan: PLAN },
      isJoined: true,
      calls: [['labels', 'plan']],
    })
  })

  it('stops a plan still running after 30 seconds and counts it as failed, with its last stderr line', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stub.answer(0, ['Detecting Claude Code'], { isWaiting: true })
    const planned = labelling.plan(null)
    await stub.pid()

    // Act
    await vi.advanceTimersByTimeAsync(labelling.PLAN_TIMEOUT_MS)
    const result = await planned

    // Assert
    expect(result).toStrictEqual({
      kind: 'failed',
      exit: {
        pid: expect.any(Number) as number,
        code: null,
        lastLine: 'Detecting Claude Code',
        at: expect.any(Number) as number,
      },
    })
  })

  it('keeps how the last plan exited', async () => {
    // Arrange
    stub.answer(7, ['Labelling  needs Claude Code: install it or set CLAUDE_BIN'])

    // Act
    const result = await labelling.plan(null)

    // Assert
    expect({ result, kept: labelling.labellingProcess().planExit }).toStrictEqual({
      result: { kind: 'failed', exit: expect.objectContaining({ code: 7 }) as unknown },
      kept: expect.objectContaining({
        code: 7,
        lastLine: 'Labelling  needs Claude Code: install it or set CLAUDE_BIN',
      }) as unknown,
    })
  })
})

describe('the run', () => {
  it('starts without waiting, starts nothing a second time while it lives, and stops on SIGTERM', async () => {
    // Arrange
    stub.answer(0, [], { isWaiting: true })

    // Act
    const isStarted = labelling.startRun('claude-haiku-4-5')
    const pid = await stub.pid()
    const isStartedAgain = labelling.startRun(null)
    const whileRunning = labelling.labellingProcess().run
    const isStopped = labelling.stopRun()
    const whileStopping = labelling.labellingProcess().run
    await vi.waitFor(() => {
      expect(labelling.labellingProcess().runExit).not.toBeNull()
    })

    // Assert
    expect({
      isStarted,
      isStartedAgain,
      whileRunning,
      isStopped,
      whileStopping,
      after: labelling.labellingProcess(),
      calls: await stub.calls(),
    }).toStrictEqual({
      isStarted: true,
      isStartedAgain: false,
      whileRunning: { pid, isStopSent: false },
      isStopped: true,
      whileStopping: { pid, isStopSent: true },
      after: {
        run: null,
        runExit: { pid, code: null, lastLine: null, at: expect.any(Number) as number },
        planExit: null,
        isUpdated: false,
      },
      calls: [['labels', 'update', '--model', 'claude-haiku-4-5']],
    })
  })

  it('sends nothing when there is no run child alive', () => {
    // Act
    const isStopped = labelling.stopRun()

    // Assert
    expect({ isStopped, run: labelling.labellingProcess().run }).toStrictEqual({ isStopped: false, run: null })
  })

  it('keeps a run that exited updated while running for every later state', async () => {
    // Arrange
    stub.answer(9)

    // Act
    labelling.startRun(null)
    await vi.waitFor(() => {
      expect(labelling.labellingProcess().runExit).not.toBeNull()
    })

    // Assert
    expect(labelling.labellingProcess()).toMatchObject({ runExit: { code: 9 }, isUpdated: true })
  })
})

describe('the model', () => {
  it('passes an allowed model as its own argument after --model', async () => {
    // Arrange
    stub.answer(0, [], { stdout: JSON.stringify(PLAN) })

    // Act
    // One after the other: a plan requested while another runs joins it.
    await labelling.plan('claude-haiku-4-5')
    await labelling.plan('claude-sonnet-5-5@20260101')

    // Assert
    expect(await stub.calls()).toStrictEqual([
      ['labels', 'plan', '--model', 'claude-haiku-4-5'],
      ['labels', 'plan', '--model', 'claude-sonnet-5-5@20260101'],
    ])
  })

  it('refuses any other value before a child starts, naming the allowed characters', async () => {
    // Arrange
    const refused = ['', '--help', '-x', 'claude haiku', 'a'.repeat(129)]

    // Act
    const planErrors = await Promise.all(
      refused.map(async (model) => labelling.plan(model).catch((error: unknown) => error))
    )
    const runErrors = refused.map((model) => {
      try {
        return labelling.startRun(model)
      } catch (error) {
        return error
      }
    })

    // Assert
    expect({
      areParamErrors: [...planErrors, ...runErrors].every((error) => error instanceof errors.ParamError),
      message: (planErrors[1] as Error).message,
      calls: await stub.calls(),
    }).toStrictEqual({
      areParamErrors: true,
      message:
        'The model must start with a letter or digit and hold only letters, digits, . _ - : or @ (at most 128 characters), got "--help"',
      calls: [],
    })
  })
})
