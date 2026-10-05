import type { IEngine, ILabelFacts, ILabelRunReport, LabelRunResult } from '@log-book/engine'
import { WarehouseLockHeldError } from '@log-book/warehouse'
import { describe, expect, it, vi } from 'vitest'
import { createLabelRunners } from './labels-run.js'
import { runCli } from './run-cli.js'

type TLabels = IEngine['labels']
type TCall = Parameters<TLabels['update']>[0]
type TProgressEvent = Parameters<NonNullable<TCall['onProgress']>>[0]

interface IRun {
  code: number
  stdout: string
  stderr: string
}

interface IScript {
  facts?: ILabelFacts
  events?: TProgressEvent[]
  result: LabelRunResult
}

const HOME = '/home/example'
const LIMIT_TEXT = 'Stopped at your Claude usage limit (Example limit reached, resets at 5pm).'

const facts = (fields: Partial<ILabelFacts> = {}): ILabelFacts => ({
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
    { id: 'claude-code', name: 'Claude Code', records: 1630 },
    { id: 'opencode', name: 'OpenCode', records: 584 },
  ],
  records: 2214,
  estimatedInputTokens: 561_234,
  ...fields,
})

const report = (fields: Partial<ILabelRunReport> = {}): ILabelRunReport => ({
  status: 'ran',
  outcome: 'ok',
  failureKind: null,
  tasks: [{ task: 'shell', planned: 2214, done: 2214, unanswered: 0 }],
  totals: { planned: 2214, done: 2214, unanswered: 0, inputTokens: 1, outputTokens: 1 },
  error: null,
  durationMs: 18 * 60_000,
  ...fields,
})

const partial = (fields: Partial<ILabelRunReport>): ILabelRunReport =>
  report({
    tasks: [{ task: 'shell', planned: 2214, done: 1240, unanswered: 0 }],
    totals: { planned: 2214, done: 1240, unanswered: 0, inputTokens: 1, outputTokens: 1 },
    ...fields,
  })

const scripted =
  ({ facts: preflight, events = [], result }: IScript) =>
  async (call: TCall): Promise<LabelRunResult> => {
    if (preflight !== undefined) {
      call.onPreflight?.(preflight)
    }
    for (const event of events) {
      call.onProgress?.(event)
    }
    return Promise.resolve(result)
  }

const standInLabels = (update: TLabels['update'], run: TLabels['run'] = vi.fn<TLabels['run']>()): TLabels => ({
  detect: vi.fn<TLabels['detect']>(),
  plan: vi.fn<TLabels['plan']>(),
  preview: vi.fn<TLabels['preview']>(),
  compare: vi.fn<TLabels['compare']>(),
  drop: vi.fn<TLabels['drop']>(),
  update,
  run,
})

const run = async (argv: readonly string[], labels: TLabels, isStderrTty = false): Promise<IRun> => {
  let stdout = ''
  let stderr = ''
  const code = await runCli(
    {
      argv,
      env: {},
      home: HOME,
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      isStderrTty,
      signal: new AbortController().signal,
    },
    createLabelRunners(() => labels)
  )
  return { code, stdout, stderr }
}

const update = async (script: IScript, isStderrTty = false): Promise<IRun> =>
  run(['labels', 'update'], standInLabels(scripted(script)), isStderrTty)

const lines = (text: string): string[] => text.split('\n').filter((line) => line.length > 0)

const event = (task: TProgressEvent['task'], planned: number, labelled: number): TProgressEvent => ({
  task,
  planned,
  labelled,
  unanswered: 0,
  inputTokens: 0,
  outputTokens: 0,
  minutes: 0,
  stop: null,
})

describe('labels update and labels run', () => {
  describe('endings', () => {
    it.each([
      [
        'nothing pending',
        report({ tasks: [], totals: { planned: 0, done: 0, unanswered: 0, inputTokens: 0, outputTokens: 0 } }),
        0,
        'Nothing to label: every record already has a label from a model.',
      ],
      ['every record answered', report(), 0, 'Labelled 2,214 records in 18 min.'],
      [
        'records left unanswered',
        report({ totals: { planned: 2214, done: 2211, unanswered: 3, inputTokens: 1, outputTokens: 1 } }),
        0,
        'Labelled 2,211 records in 18 min.\n3 records got no answer; the next run asks for them again.',
      ],
      [
        'a stop',
        partial({ outcome: 'stopped' }),
        130,
        'Labelling stopped: 1,240 of 2,214 records labelled and kept. Run the same command again to continue.',
      ],
      [
        'a usage limit',
        partial({ outcome: 'limit', error: LIMIT_TEXT }),
        8,
        `${LIMIT_TEXT} 1,240 of 2,214 records labelled and kept. Run the same command again once the limit resets.`,
      ],
      [
        'no response from the API',
        partial({
          outcome: 'unreachable',
          error: 'Labelling stopped: Claude Code could not reach its API (No response from API).',
        }),
        1,
        'Labelling stopped: Claude Code could not reach its API (No response from API). 1,240 of 2,214 records ' +
          'labelled and kept. Run the same command again when you are online.',
      ],
      [
        'an error result',
        partial({
          outcome: 'failed',
          failureKind: 'failure',
          error: 'Labelling failed on claude-haiku-4-5: claude exited with code 3 and gave no result.',
        }),
        1,
        'Labelling failed on claude-haiku-4-5: claude exited with code 3 and gave no result. 1,240 of 2,214 ' +
          'records labelled and kept. Run the same command again once fixed, for example with another --model.',
      ],
      [
        'a refused authentication',
        partial({
          outcome: 'failed',
          failureKind: 'not-signed-in',
          error: 'Claude Code is not signed in (Example 401 text).',
        }),
        7,
        'Claude Code is not signed in (Example 401 text). Run claude, sign in, then run this again. 1,240 of ' +
          '2,214 records labelled and kept.',
      ],
      [
        'a vanished binary',
        partial({
          outcome: 'failed',
          failureKind: 'not-found',
          error: 'Claude Code was not found (example spawn error).',
        }),
        7,
        'needs Claude Code: install it (https://claude.com/claude-code) or set CLAUDE_BIN. 1,240 of 2,214 records ' +
          'labelled and kept.',
      ],
    ])('ends %s with its summary on stdout and its exit code', async (_case, result, code, summary) => {
      // Act
      const ran = await update({ result })

      // Assert
      expect({ code: ran.code, stdout: ran.stdout }).toStrictEqual({ code, stdout: `${summary}\n` })
    })

    it('stops at exit 7 with the prerequisite line when detection finds no claude', async () => {
      // Act
      const ran = await update({ result: { status: 'missing', missing: { kind: 'not-signed-in' } } })

      // Assert
      expect(ran).toStrictEqual({
        code: 7,
        stdout: '',
        stderr: 'Claude Code is not signed in. Run claude, sign in, then run this again.\n',
      })
    })

    it('stops at exit 3 with the holder line when another labelling command holds the lock', async () => {
      // Arrange
      const path = '/tmp/example/warehouse.db.labels.lock'
      const held = new WarehouseLockHeldError('held', { pid: 4242, startedAt: 1, operation: 'labels', path })

      // Act
      const ran = await run(['labels', 'update'], standInLabels(vi.fn<TLabels['update']>().mockRejectedValue(held)))

      // Assert
      expect(ran.code).toBe(3)
      expect(ran.stderr).toMatch(/^Another labelling command is running on this warehouse/u)
    })
  })

  describe('the preflight', () => {
    it('says what a subscription run sends, by task and by agent, with the estimate', async () => {
      // Act
      const ran = await update({ facts: facts(), result: report() })

      // Assert: the preflight, then the progress of the run
      expect(lines(ran.stderr)).toStrictEqual([
        'Labelling with your own claude 2.1.290, signed in with a Claude subscription, on claude-haiku-4-5.',
        'To label: 2,214 records (shell calls 2,140, sessions 12, outcomes 9, prompts 31, replies 22); by agent: ' +
          'Claude Code 1,630, OpenCode 584.',
        "Requests count against your Claude plan's usage limits. Excerpts of these records go to Anthropic " +
          'through Claude Code; nothing is redacted.',
        'Estimated: about 560,000 input tokens. Press Ctrl+C to stop; what is labelled is kept.',
        'shell calls    2,214 of 2,214',
      ])
    })

    it('names an API key sign-in as billed to that account', async () => {
      // Act
      const ran = await update({ facts: facts({ authMethod: 'console' }), result: report() })

      // Assert
      expect(lines(ran.stderr)[0]).toBe(
        'Labelling with your own claude 2.1.290, signed in with an API key; labelling is billed to that account, on ' +
          'claude-haiku-4-5.'
      )
      expect(lines(ran.stderr)[2]).toBe(
        'Excerpts of these records go to Anthropic through Claude Code; nothing is redacted.'
      )
    })

    it('names the provider Claude Code sends to when it is not Anthropic', async () => {
      // Act
      const ran = await update({ facts: facts({ authMethod: 'console', apiProvider: 'bedrock' }), result: report() })

      // Assert
      expect(lines(ran.stderr)[2]).toBe(
        'Excerpts of these records go to Amazon Bedrock through Claude Code; nothing is redacted.'
      )
    })

    it('warns after the first line when ANTHROPIC_API_KEY is set', async () => {
      // Act
      const ran = await update({ facts: facts({ apiKeyInEnvironment: true }), result: report() })

      // Assert
      expect(lines(ran.stderr).slice(0, 2)).toStrictEqual([
        'Labelling with your own claude 2.1.290, signed in with a Claude subscription, on claude-haiku-4-5.',
        'ANTHROPIC_API_KEY is set, so Claude Code may bill this run to that key instead of your plan.',
      ])
    })

    it('says there is nothing to label and leaves out the estimate', async () => {
      // Arrange
      const nothing = facts({
        tasks: [{ task: 'shell', records: 0 }],
        harnesses: [],
        records: 0,
        estimatedInputTokens: 0,
      })

      // Act
      const ran = await update({
        facts: nothing,
        result: report({ tasks: [], totals: { planned: 0, done: 0, unanswered: 0, inputTokens: 0, outputTokens: 0 } }),
      })

      // Assert
      expect(lines(ran.stderr)).toStrictEqual([
        'Labelling with your own claude 2.1.290, signed in with a Claude subscription, on claude-haiku-4-5.',
        'To label: nothing. Every record already has a label from a model.',
        "Requests count against your Claude plan's usage limits. Excerpts of these records go to Anthropic " +
          'through Claude Code; nothing is redacted.',
      ])
    })
  })

  describe('progress', () => {
    const events = [event('shell', 2140, 600), event('shell', 2140, 2140), event('prompt', 1, 1)]
    const done = report({
      tasks: [
        { task: 'shell', planned: 2140, done: 2140, unanswered: 0 },
        { task: 'session', planned: 0, done: 0, unanswered: 0 },
        { task: 'prompt', planned: 1, done: 1, unanswered: 0 },
      ],
    })

    it('prints each task line once, as its task ends, off a terminal', async () => {
      // Act
      const ran = await update({ events, result: done })

      // Assert
      expect(ran.stderr).toBe('shell calls    2,140 of 2,140\nprompt         1 of 1\n')
    })

    it('prints an ended task line at once, before a later failure ends the run', async () => {
      // Arrange
      const failing = vi.fn<TLabels['update']>(async (call) => {
        call.onProgress?.(event('shell', 2140, 2140))
        return Promise.reject(new Error('example warehouse failure'))
      })

      // Act
      const ran = await run(['labels', 'update'], standInLabels(failing))

      // Assert
      expect(ran).toStrictEqual({
        code: 1,
        stdout: '',
        stderr: 'shell calls    2,140 of 2,140\nexample warehouse failure\n',
      })
    })

    it('redraws the task lines in place as batches land on a terminal', async () => {
      // Act
      const ran = await update({ events, result: done }, true)

      // Assert
      expect(ran.stderr.split('\u001B[2K')).toStrictEqual([
        '',
        'shell calls    600 of 2,140\n\u001B[1A',
        'shell calls    2,140 of 2,140\n\u001B[1A',
        'shell calls    2,140 of 2,140\n',
        'prompt         1 of 1\n\u001B[2A',
        'shell calls    2,140 of 2,140\n',
        'prompt         1 of 1\n',
      ])
    })
  })

  describe('labels run', () => {
    it('passes its task, model, sample and limit to the engine', async () => {
      // Arrange
      const runTask = vi.fn<TLabels['run']>().mockResolvedValue(report())

      // Act
      const ran = await run(
        ['labels', 'run', '--task', 'reply', '--model', 'claude-sonnet-5-5', '--sample', '20', '--limit', '5'],
        standInLabels(vi.fn<TLabels['update']>(), runTask)
      )

      // Assert
      expect(ran.code).toBe(0)
      expect(runTask).toHaveBeenCalledWith(
        expect.objectContaining({ task: 'reply', model: 'claude-sonnet-5-5', sample: 20, limit: 5 })
      )
    })
  })
})
