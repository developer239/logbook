import type { IEngine, ILabelFacts, ILabelPreview } from '@log-book/engine'
import { describe, expect, it, vi } from 'vitest'
import { createLabelReadRunners } from './labels-read.js'
import { runCli } from './run-cli.js'

type TLabels = IEngine['labels']

interface IRun {
  code: number
  stdout: string
  stderr: string
}

const FACTS: ILabelFacts = {
  model: 'claude-haiku-4-5',
  claudeVersion: '2.1.290',
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  apiKeyInEnvironment: false,
  tasks: [
    { task: 'shell', records: 2140 },
    { task: 'tool-failure', records: 0 },
  ],
  harnesses: [{ id: 'claude-code', name: 'Claude Code', records: 2140 }],
  records: 2140,
  estimatedInputTokens: 560_000,
}
const NOTE = 'Example note on the framing Claude Code adds.'

const standInLabels = (fields: Partial<TLabels>): TLabels => ({
  detect: vi.fn<TLabels['detect']>(),
  plan: vi.fn<TLabels['plan']>(),
  preview: vi.fn<TLabels['preview']>(),
  compare: vi.fn<TLabels['compare']>(),
  drop: vi.fn<TLabels['drop']>(),
  update: vi.fn<TLabels['update']>(),
  run: vi.fn<TLabels['run']>(),
  ...fields,
})

const run = async (argv: readonly string[], labels: TLabels): Promise<IRun> => {
  let stdout = ''
  let stderr = ''
  const code = await runCli(
    {
      argv,
      env: {},
      home: '/home/example',
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      isStderrTty: false,
      signal: new AbortController().signal,
    },
    createLabelReadRunners(() => labels)
  )
  return { code, stdout, stderr }
}

const preview = (batches: ILabelPreview['batches']): ILabelPreview => ({
  task: 'shell',
  system: 'Example system line.',
  batches,
  note: NOTE,
})

describe('labels plan', () => {
  it('prints the facts as one JSON object on one line, with the engine field names', async () => {
    // Arrange
    const plan = vi.fn<TLabels['plan']>().mockResolvedValue({ status: 'ready', facts: FACTS })

    // Act
    const result = await run(['labels', 'plan', '--model', 'claude-sonnet-5-5'], standInLabels({ plan }))

    // Assert
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.split('\n')).toStrictEqual([expect.any(String), ''])
    expect(JSON.parse(result.stdout) as unknown).toStrictEqual(FACTS)
    expect(Object.keys(JSON.parse(result.stdout) as object)).toStrictEqual([
      'model',
      'claudeVersion',
      'authMethod',
      'apiProvider',
      'apiKeyInEnvironment',
      'tasks',
      'harnesses',
      'records',
      'estimatedInputTokens',
    ])
    expect(plan).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) as AbortSignal, model: 'claude-sonnet-5-5' })
  })

  it('stops at exit 7 with the prerequisite line on stderr and nothing on stdout', async () => {
    // Arrange
    const plan = vi.fn<TLabels['plan']>().mockResolvedValue({ status: 'missing', missing: { kind: 'not-signed-in' } })

    // Act
    const result = await run(['labels', 'plan'], standInLabels({ plan }))

    // Assert
    expect(result).toStrictEqual({
      code: 7,
      stdout: '',
      stderr: 'Claude Code is not signed in. Run claude, sign in, then run this again.\n',
    })
  })
})

describe('labels preview', () => {
  it('shows one batch with the system line and the note', async () => {
    // Arrange
    const show = vi.fn<TLabels['preview']>().mockResolvedValue(preview([{ prompt: 'Example batch one.', records: 25 }]))

    // Act
    const result = await run(['labels', 'preview', '--task', 'shell'], standInLabels({ preview: show }))

    // Assert
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(
      [
        'Preview of task shell: the next 1 batch, 25 records, exactly as labelling would send it now. Nothing is sent.',
        '',
        'System line (passed to claude as --system-prompt):',
        'Example system line.',
        '',
        'Batch 1 of 1 (sent on the stdin of one claude -p call, 25 records):',
        'Example batch one.',
        '',
        NOTE,
        '',
      ].join('\n')
    )
    expect(show).toHaveBeenCalledWith({ task: 'shell', batches: 1 })
  })

  it('shows three batches in order', async () => {
    // Arrange
    const show = vi.fn<TLabels['preview']>().mockResolvedValue(
      preview([
        { prompt: 'Example batch one.', records: 25 },
        { prompt: 'Example batch two.', records: 25 },
        { prompt: 'Example batch three.', records: 1 },
      ])
    )

    // Act
    const result = await run(
      ['labels', 'preview', '--task', 'shell', '--batches', '3'],
      standInLabels({ preview: show })
    )

    // Assert
    expect(result.stdout).toBe(
      [
        'Preview of task shell: the next 3 batches, 51 records, exactly as labelling would send them now. Nothing ' +
          'is sent.',
        '',
        'System line (passed to claude as --system-prompt):',
        'Example system line.',
        '',
        'Batch 1 of 3 (sent on the stdin of one claude -p call, 25 records):',
        'Example batch one.',
        '',
        'Batch 2 of 3 (sent on the stdin of one claude -p call, 25 records):',
        'Example batch two.',
        '',
        'Batch 3 of 3 (sent on the stdin of one claude -p call, 1 record):',
        'Example batch three.',
        '',
        NOTE,
        '',
      ].join('\n')
    )
    expect(show).toHaveBeenCalledWith({ task: 'shell', batches: 3 })
  })

  it('says there is nothing to label when no record is pending', async () => {
    // Arrange
    const show = vi.fn<TLabels['preview']>().mockResolvedValue(preview([]))

    // Act
    const result = await run(['labels', 'preview', '--task', 'shell'], standInLabels({ preview: show }))

    // Assert
    expect(result).toStrictEqual({
      code: 0,
      stdout: 'Preview of task shell: nothing to label; every record already has a label from a model.\n',
      stderr: '',
    })
  })
})

describe('labels compare', () => {
  it("prints the engine's comparison of the two labellers", async () => {
    // Arrange
    const compare = vi.fn<TLabels['compare']>().mockResolvedValue('# Example comparison')

    // Act
    const result = await run(
      ['labels', 'compare', '--task', 'reply', '--first', 'rules', '--second', 'claude-haiku-4-5'],
      standInLabels({ compare })
    )

    // Assert
    expect(result).toStrictEqual({ code: 0, stdout: '# Example comparison\n', stderr: '' })
    expect(compare).toHaveBeenCalledWith({ task: 'reply', first: 'rules', second: 'claude-haiku-4-5' })
  })
})
