import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RULES_LABELLER, WarehouseStore } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFakeClaude, type FakeClaudeRule, type IFakeClaude } from '../../testing/index.js'
import { PROMPT_ACTS, REACTION_TARGETS, REACTIONS } from '../vocabularies.js'
import { runLabelTask, type ILabelTaskResult, type ILabelTaskRun } from './label-runner.js'
import type { ILabelRunTask } from './label-task.js'

const MODEL = 'claude-haiku-4-5'
const SYSTEM = 'Answer each tagged item on its own line, starting with its tag.'
const PURPOSES = ['build', 'test', 'other']

const callId = (index: number): string => `tc-${String(index).padStart(2, '0')}`

const SHELL_TASK: ILabelRunTask = {
  name: 'shell',
  recordType: 'tool_call',
  version: 1,
  fields: [{ name: 'purpose', values: PURPOSES }],
  batchSize: 10,
  system: SYSTEM,
  instructions: 'Label what each command is for.',
  candidates: (reader) =>
    reader
      .all<{ id: string; input_json: string }>('SELECT id, input_json FROM tool_call ORDER BY id')
      .map((row) => ({ recordId: row.id, text: row.input_json })),
}

const PROMPT_TASK: ILabelRunTask = {
  name: 'prompt',
  recordType: 'message',
  version: 1,
  fields: [{ name: 'act', values: PROMPT_ACTS }],
  entries: {
    recordType: 'reaction',
    description: 'reaction in the prompt',
    fields: [
      { name: 'reaction', values: REACTIONS },
      { name: 'target', values: REACTION_TARGETS },
    ],
    example: '0 1',
  },
  batchSize: 8,
  system: SYSTEM,
  instructions: 'Label each prompt.',
  candidates: (reader) =>
    reader.all<{ id: string }>('SELECT id FROM message ORDER BY id').map((row) => ({ recordId: row.id, text: row.id })),
}

// The fake processes alive under this test process, from pgrep.
const childCount = (): number =>
  spawnSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter((line) => line !== '').length

describe('runLabelTask', () => {
  let directory = ''
  let warehouse: ITestWarehouse | null = null
  let store: WarehouseStore | null = null

  const opened = (): { warehouse: ITestWarehouse; store: WarehouseStore } => {
    if (warehouse === null || store === null) {
      throw new Error('The warehouse is not open.')
    }
    return { warehouse, store }
  }

  const install = async (answer: string, rules: FakeClaudeRule[] = []): Promise<IFakeClaude> => {
    const bin = await mkdtemp(join(directory, 'bin-'))
    return installFakeClaude(bin, { answers: [{ systemPrompt: SYSTEM, answer }], rules })
  }

  const addCalls = (count: number): void => {
    for (let index = 0; index < count; index += 1) {
      insert(opened().warehouse.db, 'tool_call', {
        id: callId(index),
        session_id: 's',
        message_id: 'm',
        name: 'Bash',
        bare_name: 'Bash',
        family: 'shell',
        input_json: `{"command":"cmd-${String(index)}"}`,
        status: 'ok',
      })
    }
  }

  const label = async (
    fake: IFakeClaude,
    fields: Partial<Omit<ILabelTaskRun, 'store' | 'runId' | 'claude'>> & { timeoutMs?: number } = {}
  ): Promise<ILabelTaskResult> => {
    const { timeoutMs, ...rest } = fields
    const task = rest.task ?? SHELL_TASK
    const model = rest.model ?? MODEL
    const runId = opened().store.startLabelRun({
      pid: process.pid,
      startedAt: Date.now(),
      model,
      tasks: [{ task: task.name, version: task.version, planned: 0 }],
    })
    return runLabelTask({
      store: opened().store,
      runId,
      task,
      model,
      doneBy: 'own-model',
      claude: { binary: fake.path, cwd: directory, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
      concurrency: 1,
      signal: new AbortController().signal,
      ...rest,
    })
  }

  const labelled = (name = 'purpose', labeller = MODEL): string[] =>
    (
      opened()
        .warehouse.db.prepare('SELECT DISTINCT record_id AS id FROM label WHERE name = ? AND labeller = ? ORDER BY id')
        .all(name, labeller) as { id: string }[]
    ).map(({ id }) => id)

  const done = (): number[] =>
    (opened().warehouse.db.prepare('SELECT done FROM label_run_task ORDER BY run_id').all() as { done: number }[]).map(
      (row) => row.done
    )

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-label-run-')))
    await mkdir(join(directory, 'run'))
    warehouse = await createTestWarehouse()
    store = await WarehouseStore.open(warehouse.path)
  })

  afterEach(async () => {
    store?.close()
    store = null
    await warehouse?.remove()
    warehouse = null
    await rm(directory, { recursive: true, force: true })
  })

  it('labels every item after a tag missing from the whole batch, in batches of 5', async () => {
    // Arrange
    addCalls(8)
    const fake = await install('1', [{ marker: 'cmd-3', kind: 'omit-tag', minItems: 6 }])

    // Act
    const result = await label(fake)

    // Assert
    expect({
      labelled: labelled().length,
      calls: (await fake.readRecords()).length,
      unanswered: result.unanswered,
    }).toStrictEqual({
      labelled: 8,
      calls: 4,
      unanswered: 0,
    })
  })

  it('leaves an item that fails in its batch of 5 unlabelled, pending on the next run', async () => {
    // Arrange
    addCalls(8)
    const failing = await install('1', [{ marker: 'cmd-3', kind: 'omit-tag' }])
    const first = await label(failing)

    // Act
    const next = await label(await install('1'))

    // Assert
    expect({ first: [first.labelled, first.unanswered], next: [next.planned, next.labelled] }).toStrictEqual({
      first: [3, 5],
      next: [5, 5],
    })
  })

  it('writes two reactions of one kind with different targets as #1 and #2, and a repeated entry line once', async () => {
    // Arrange
    for (const id of ['m-0', 'm-1']) {
      insert(opened().warehouse.db, 'message', {
        id,
        session_id: 's',
        seq: 0,
        actor: 'user',
        source_role: 'user',
        created_at: 1,
      })
    }
    const fake = await install('0\n{tag} + 0 1\n{tag} + 0 2\n{tag} + 0 2')

    // Act
    await label(fake, { task: PROMPT_TASK })

    // Assert
    const reactions = opened()
      .warehouse.db.prepare(
        "SELECT record_id AS id, name, value FROM label WHERE record_type = 'reaction' ORDER BY record_id, name"
      )
      .all() as object[]
    expect(reactions.map((row) => ({ ...row }))).toStrictEqual(
      ['m-0', 'm-1'].flatMap((id) => [
        { id: `${id}#1`, name: 'reaction', value: REACTIONS[0] },
        { id: `${id}#1`, name: 'target', value: REACTION_TARGETS[1] },
        { id: `${id}#2`, name: 'reaction', value: REACTIONS[0] },
        { id: `${id}#2`, name: 'target', value: REACTION_TARGETS[2] },
      ])
    )
  })

  it('writes every label at concurrency 4 with at most 4 claude processes alive at once', async () => {
    // Arrange
    addCalls(40)
    const fake = await install('1', [{ marker: 'cmd-', kind: 'delay', ms: 300 }])
    let most = 0
    const watch = setInterval(() => {
      most = Math.max(most, childCount())
    }, 20)

    // Act
    try {
      await label(fake, { task: { ...SHELL_TASK, batchSize: 4 }, concurrency: 4 })
    } finally {
      clearInterval(watch)
    }

    // Assert
    expect({ labelled: labelled().length, isParallel: most > 1, isAtMostFour: most <= 4 }).toStrictEqual({
      labelled: 40,
      isParallel: true,
      isAtMostFour: true,
    })
  })

  it('keeps the batches written before a usage limit, starts no new one, and resumes with the rest', async () => {
    // Arrange
    addCalls(6)
    const limited = await install('1', [{ marker: 'cmd-3', kind: 'envelope', envelope: 'usage-limit' }])
    const first = await label(limited, { task: { ...SHELL_TASK, batchSize: 2 } })
    const resumed = await install('1')

    // Act
    const next = await label(resumed, { task: { ...SHELL_TASK, batchSize: 2 } })

    // Assert
    const asked = (await resumed.readRecords()).map((record) => record.stdin)
    expect({
      first: { labelled: first.labelled, stop: first.stop?.outcome, calls: (await limited.readRecords()).length },
      next: { planned: next.planned, labelled: next.labelled },
      isFirstBatchAskedAgain: asked.some((stdin) => stdin.includes('cmd-0')),
    }).toStrictEqual({
      first: { labelled: 2, stop: 'limit', calls: 2 },
      next: { planned: 4, labelled: 4 },
      isFirstBatchAskedAgain: false,
    })
  })

  it('kills a batch that never answers at the shortened timeout and writes the others, ending normally', async () => {
    // Arrange
    addCalls(6)
    const fake = await install('1', [{ marker: 'cmd-3', kind: 'never' }])

    // Act
    const result = await label(fake, { task: { ...SHELL_TASK, batchSize: 2 }, timeoutMs: 500 })

    // Assert
    expect({ labelled: labelled(), unanswered: result.unanswered, stop: result.stop }).toStrictEqual({
      labelled: [callId(0), callId(1), callId(4), callId(5)],
      unanswered: 2,
      stop: null,
    })
  })

  it("keeps the task's done equal to the records labelled after each batch", async () => {
    // Arrange
    addCalls(6)
    const fake = await install('1')
    const pairs: number[][] = []

    // Act
    await label(fake, {
      task: { ...SHELL_TASK, batchSize: 2 },
      onProgress: () => {
        pairs.push([done()[0] ?? -1, labelled().length])
      },
    })

    // Assert
    expect(pairs).toStrictEqual([
      [2, 2],
      [4, 4],
      [6, 6],
    ])
  })

  it('samples the same records for two models, and a limit labels that many', async () => {
    // Arrange
    addCalls(8)
    const fake = await install('1')

    // Act
    await label(fake, { sample: 3 })
    await label(fake, { sample: 3, model: 'claude-sonnet-5-5' })
    const limited = await label(fake, { limit: 2, model: 'claude-opus-5-5' })

    // Assert
    expect({
      haiku: labelled(),
      isSameSample: labelled('purpose', 'claude-sonnet-5-5').join() === labelled().join(),
      limited: limited.labelled,
    }).toMatchObject({ haiku: expect.any(Array) as string[], isSameSample: true, limited: 2 })
    expect(labelled()).toHaveLength(3)
  })

  it.each([
    ['labels update counts another model as done and rules as not', 'any-model', [callId(1), callId(2)]],
    ['labels run counts only its own model as done', 'own-model', [callId(0), callId(1), callId(2)]],
  ] as const)('%s', async (_case, doneBy, pending) => {
    // Arrange
    addCalls(3)
    for (const [recordId, labeller] of [
      [callId(0), 'claude-sonnet-5-5'],
      [callId(1), RULES_LABELLER],
    ]) {
      insert(opened().warehouse.db, 'label', {
        record_type: 'tool_call',
        record_id: recordId ?? '',
        labeller: labeller ?? '',
        version: 1,
        name: 'purpose',
        value: 'test',
        labelled_at: 1,
      })
    }
    const fake = await install('1')

    // Act
    const result = await label(fake, { doneBy })

    // Assert
    expect({ planned: result.planned, labelled: labelled() }).toStrictEqual({
      planned: pending.length,
      labelled: pending,
    })
  })
})
