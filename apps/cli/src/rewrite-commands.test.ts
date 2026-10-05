import { resolve } from 'node:path'
import type { ICompactResult, IForgetSessionsResult } from '@log-book/engine'
import { WarehouseLockHeldError, WarehouseSessionUnknownError } from '@log-book/warehouse'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRewriteRunners, type RewriteOperations } from './rewrite-commands.js'
import { runCli } from './run-cli.js'

type TOperations = ReturnType<RewriteOperations>

interface IRun {
  code: number
  stdout: string
  stderr: string
}

const HOME = '/home/example'
const WAREHOUSE = `${HOME}/.local/share/log-book/warehouse.db`
const GB_1_3 = 1_300_000_000
const GB_1_1 = 1_100_000_000
const GB_1_2 = 1_200_000_000
const COMPACTING =
  'Compacting ~/.local/share/log-book/warehouse.db (1.3 GB). This rewrites the whole file and needs up to 2.6 GB ' +
  'of free disk; syncs and labelling wait until it ends.'

const compacted = (fields: Partial<ICompactResult> = {}): ICompactResult => ({
  outcome: 'ok',
  isRewritten: true,
  error: null,
  sizeBefore: GB_1_3,
  sizeAfter: GB_1_1,
  durationMs: 130_000,
  ...fields,
})

const forgot = (fields: Partial<IForgetSessionsResult> = {}): IForgetSessionsResult => ({
  outcome: 'ok',
  state: 'rewritten',
  sessionCount: 16,
  labelCount: 210,
  error: null,
  sizeBefore: GB_1_3,
  sizeAfter: GB_1_2,
  durationMs: 1000,
  ...fields,
})

const compactWith = (result: ICompactResult): TOperations['compact'] =>
  vi.fn<TOperations['compact']>(async ({ onProgress }) => {
    onProgress?.({ phase: 'started', sizeBefore: result.sizeBefore })
    return Promise.resolve(result)
  })

const forgetWith = (result: IForgetSessionsResult, named = 12, subagents = 4): TOperations['forget'] =>
  vi.fn<TOperations['forget']>(async ({ onProgress }) => {
    onProgress?.({ phase: 'resolved', named, subagents })
    onProgress?.({ phase: 'started', sizeBefore: result.sizeBefore })
    return Promise.resolve(result)
  })

const run = async (argv: readonly string[], operations: Partial<TOperations>): Promise<IRun> => {
  let stdout = ''
  let stderr = ''
  const stand: TOperations = {
    compact: vi.fn<TOperations['compact']>(),
    forget: vi.fn<TOperations['forget']>(),
    ...operations,
  }
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
      isStderrTty: false,
      signal: new AbortController().signal,
    },
    createRewriteRunners(() => stand)
  )
  return { code, stdout, stderr }
}

const lines = (text: string): string[] => text.split('\n').filter((line) => line.length > 0)

beforeEach(() => {
  vi.stubEnv('LOGBOOK_DB', WAREHOUSE)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('logbook compact', () => {
  it('names the file, its size and twice it in free disk first, then the result on stdout', async () => {
    // Act
    const result = await run(['compact'], { compact: compactWith(compacted()) })

    // Assert
    expect(result).toStrictEqual({
      code: 0,
      stdout: 'Compacted in 2 min 10 s: 1.3 GB before, 1.1 GB after.\n',
      stderr: `${COMPACTING}\n`,
    })
  })

  it.each([
    [
      'before the rewrite took effect',
      compacted({ outcome: 'stopped', isRewritten: false, sizeAfter: GB_1_3 }),
      'Compacting stopped. SQLite rolled the rewrite back, so the warehouse file is unchanged: 1.3 GB, the same rows.',
    ],
    [
      'after the rewrite took effect',
      compacted({ outcome: 'stopped' }),
      'Compacting stopped after the rewrite had finished: 1.3 GB before, 1.1 GB after. The file shrinks to that size ' +
        'at a later sync.',
    ],
  ])('ends a stop %s with its line last and exit 130', async (_case, stopped, last) => {
    // Act
    const result = await run(['compact'], { compact: compactWith(stopped) })

    // Assert
    expect(result).toStrictEqual({ code: 130, stdout: '', stderr: `${COMPACTING}\n${last}\n` })
  })

  it("ends a failure with SQLite's message last and exit 1", async () => {
    // Act
    const result = await run(['compact'], {
      compact: compactWith(
        compacted({ outcome: 'failed', isRewritten: false, error: 'database or disk is full', sizeAfter: GB_1_3 })
      ),
    })

    // Assert
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: `${COMPACTING}\ndatabase or disk is full\n` })
  })

  it('ends at exit 3 with the holder line when a sync holds the lock', async () => {
    // Arrange
    const held = new WarehouseLockHeldError('held', {
      pid: 4242,
      startedAt: 1,
      operation: 'sync',
      path: `${WAREHOUSE}.lock`,
    })

    // Act
    const result = await run(['compact'], { compact: vi.fn<TOperations['compact']>().mockRejectedValue(held) })

    // Assert
    expect(result.code).toBe(3)
    expect(result.stderr).toBe(
      'A sync is already running on this warehouse (pid 4242, lock file ~/.local/share/log-book/warehouse.db.lock). If none is running, delete that file.\n'
    )
  })
})

describe('logbook forget', () => {
  it('names the sessions and their subagents, the compaction, then the result on stdout', async () => {
    // Arrange
    const forget = forgetWith(forgot())

    // Act
    const result = await run(['forget', '--project', `${HOME}/work/acme-shop`], { forget })

    // Assert
    expect(result).toStrictEqual({
      code: 0,
      stdout: 'Forgot 16 sessions and 210 labels. Warehouse 1.3 GB before, 1.2 GB after.\n',
      stderr: `Forgetting 12 sessions of ~/work/acme-shop and their 4 subagent sessions.\n${COMPACTING}\n`,
    })
    expect(forget).toHaveBeenCalledWith(expect.objectContaining({ project: `${HOME}/work/acme-shop` }))
  })

  it.each([
    [['example-one'], 1, 2, 'Forgetting 1 session and its 2 subagent sessions.'],
    [['example-one'], 1, 0, 'Forgetting 1 session.'],
    [['example-one', 'example-two', 'example-three'], 3, 2, 'Forgetting 3 sessions and their 2 subagent sessions.'],
  ])('words the ids %j with %i named and %i subagents', async (ids, named, subagents, first) => {
    // Arrange
    const forget = forgetWith(forgot(), named, subagents)

    // Act
    const result = await run(['forget', ...ids], { forget })

    // Assert
    expect(lines(result.stderr)[0]).toBe(first)
    expect(forget).toHaveBeenCalledWith(expect.objectContaining({ sessions: ids }))
  })

  it('passes a relative project directory as an absolute one', async () => {
    // Arrange
    const forget = forgetWith(forgot())

    // Act
    await run(['forget', '--project', 'example-project'], { forget })

    // Assert
    expect(forget).toHaveBeenCalledWith(expect.objectContaining({ project: resolve('example-project') }))
  })

  it.each([
    [
      'before the deletion took effect',
      forgot({ outcome: 'stopped', state: 'nothing-forgotten', sessionCount: 0, labelCount: 0 }),
      'Forgetting stopped before anything was deleted. Nothing was forgotten, and the warehouse file is unchanged.',
    ],
    [
      'after the deletion, before the rewrite',
      forgot({ outcome: 'stopped', state: 'forgotten' }),
      "Forgot 16 sessions and 210 labels, but compacting stopped, so their text may still be in the file's free " +
        'space. Run logbook compact to remove it.',
    ],
    [
      'after both took effect',
      forgot({ outcome: 'stopped' }),
      'Forgot 16 sessions and 210 labels; compacting stopped after the rewrite had finished: 1.3 GB before, 1.2 GB ' +
        'after. The file shrinks to that size at a later sync.',
    ],
  ])('ends a stop %s with its line last and exit 130', async (_case, stopped, last) => {
    // Act
    const result = await run(['forget', 'example-one'], { forget: forgetWith(stopped) })

    // Assert
    expect(result.code).toBe(130)
    expect(result.stdout).toBe('')
    expect(lines(result.stderr).at(-1)).toBe(last)
  })

  it("ends a full disk during the rewrite with SQLite's message, then the forgotten line, and exit 1", async () => {
    // Act
    const result = await run(['forget', 'example-one'], {
      forget: forgetWith(forgot({ outcome: 'failed', state: 'forgotten', error: 'database or disk is full' })),
    })

    // Assert
    expect(result.code).toBe(1)
    expect(lines(result.stderr).slice(-2)).toStrictEqual([
      'database or disk is full',
      "Forgot 16 sessions and 210 labels, but compacting stopped, so their text may still be in the file's free " +
        'space. Run logbook compact to remove it.',
    ])
  })

  it.each([
    [
      ['forget', 'claude-code:0000', 'claude-code:0001'],
      { sessions: ['claude-code:0000', 'claude-code:0001'] },
      'No session matches claude-code:0000, claude-code:0001.',
    ],
    [
      ['forget', '--project', `${HOME}/work/empty`],
      { project: `${HOME}/work/empty` },
      'No session belongs to the project ~/work/empty.',
    ],
  ])('refuses %j at exit 2, naming what matched nothing', async (argv, target, refusal) => {
    // Arrange
    const unknown = new WarehouseSessionUnknownError('unknown', target)

    // Act
    const result = await run(argv, { forget: vi.fn<TOperations['forget']>().mockRejectedValue(unknown) })

    // Assert
    expect(result).toStrictEqual({ code: 2, stdout: '', stderr: `${refusal}\n` })
  })
})
