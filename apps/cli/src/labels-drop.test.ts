import type { IEngine } from '@log-book/engine'
import { WarehouseLockHeldError } from '@log-book/warehouse'
import { describe, expect, it, vi } from 'vitest'
import { createLabelDropRunner } from './labels-drop.js'
import { runCli } from './run-cli.js'

type TLabels = IEngine['labels']

interface IRun {
  code: number
  stdout: string
  stderr: string
}

const LOCK = '/tmp/example/warehouse.db.labels.lock'

const run = async (argv: readonly string[], drop: TLabels['drop']): Promise<IRun> => {
  let stdout = ''
  let stderr = ''
  const labels: TLabels = {
    detect: vi.fn<TLabels['detect']>(),
    plan: vi.fn<TLabels['plan']>(),
    preview: vi.fn<TLabels['preview']>(),
    compare: vi.fn<TLabels['compare']>(),
    drop,
    update: vi.fn<TLabels['update']>(),
    run: vi.fn<TLabels['run']>(),
  }
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
    { 'labels drop': createLabelDropRunner(() => labels) }
  )
  return { code, stdout, stderr }
}

const held = (operation: string): WarehouseLockHeldError =>
  new WarehouseLockHeldError('held', { pid: 4242, startedAt: 1, operation, path: LOCK })

describe('labels drop', () => {
  it.each([
    [31, "Dropped claude-haiku-4-5's labels of 31 prompts.\n"],
    [1, "Dropped claude-haiku-4-5's labels of 1 prompt.\n"],
    [0, 'Nothing to drop: claude-haiku-4-5 has labelled no prompts.\n'],
  ])('reports %i dropped records in the task words', async (dropped, stdout) => {
    // Arrange
    const drop = vi.fn<TLabels['drop']>().mockResolvedValue(dropped)

    // Act
    const result = await run(['labels', 'drop', '--task', 'prompt', '--labeller', 'claude-haiku-4-5'], drop)

    // Assert
    expect(result).toStrictEqual({ code: 0, stdout, stderr: '' })
    expect(drop).toHaveBeenCalledWith({ task: 'prompt', labeller: 'claude-haiku-4-5' })
  })

  it('refuses the rules-based labels as a usage error without calling the engine', async () => {
    // Arrange
    const drop = vi.fn<TLabels['drop']>()

    // Act
    const result = await run(['labels', 'drop', '--task', 'prompt', '--labeller', 'rules'], drop)

    // Assert
    expect(result).toStrictEqual({
      code: 2,
      stdout: '',
      stderr: "The rules-based labels are rebuilt on every sync; only a model's labels can be dropped.\n",
    })
    expect(drop).not.toHaveBeenCalled()
  })

  it.each([
    ['labels', /^Another labelling command is running on this warehouse, /u],
    ['compact', /^Maintenance is running on this warehouse: logbook compact is rewriting it /u],
    ['forget', /^Maintenance is running on this warehouse: logbook forget is removing sessions /u],
  ])('exits 3 with the holder line when %s holds the labelling lock', async (operation, holder) => {
    // Act
    const result = await run(
      ['labels', 'drop', '--task', 'prompt', '--labeller', 'claude-haiku-4-5'],
      vi.fn<TLabels['drop']>().mockRejectedValue(held(operation))
    )

    // Assert
    expect(result.code).toBe(3)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(holder)
  })
})
