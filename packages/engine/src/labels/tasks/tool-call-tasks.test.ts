import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RULES_LABELLER, WarehouseStore } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFakeClaude } from '../../testing/index.js'
import { renderBatchPrompt } from '../runner/batch-prompt.js'
import { runLabelTask } from '../runner/label-runner.js'
import type { ILabelRunTask } from '../runner/label-task.js'
import { SHELL_PURPOSES } from '../vocabularies.js'
import { shellTask } from './shell-task.js'
import { toolFailureTask } from './tool-failure-task.js'

const MODEL = 'claude-haiku-4-5'
const LONG_COMMAND = `pnpm test --filter api ${'x'.repeat(1_300)}`
const LONG_OUTPUT = `${'.'.repeat(500)}FAIL src/orders.test.ts > rejects an empty cart\nExpected status 400, received 500`

type TRow = Record<string, string | number | null>

const call = (id: string, fields: Partial<TRow>): TRow => ({
  id,
  session_id: 's',
  message_id: 'm',
  name: 'Bash',
  bare_name: 'Bash',
  family: 'shell',
  input_json: '{}',
  status: 'ok',
  ...fields,
})

const result = (toolCallId: string, text: string): TRow => ({
  message_id: 'm',
  session_id: 's',
  idx: Number(toolCallId.slice(-1)),
  kind: 'tool_result',
  text,
  tool_call_id: toolCallId,
})

const ruleCause = (recordId: string): TRow => ({
  record_type: 'tool_call',
  record_id: recordId,
  labeller: RULES_LABELLER,
  version: 1,
  name: 'cause',
  value: 'missing target',
  labelled_at: 1,
})

describe('the shell and tool-failure tasks', () => {
  let directory = ''
  let warehouse: ITestWarehouse | null = null
  let store: WarehouseStore | null = null

  const opened = (): { warehouse: ITestWarehouse; store: WarehouseStore } => {
    if (warehouse === null || store === null) {
      throw new Error('The warehouse is not open.')
    }
    return { warehouse, store }
  }

  const arrange = (rows: readonly [string, TRow][]): void => {
    for (const [table, row] of rows) {
      insert(opened().warehouse.db, table, row)
    }
  }

  const itemsOf = (task: ILabelRunTask): Record<string, string> =>
    Object.fromEntries(task.candidates(opened().store).map((item) => [item.recordId, item.text]))

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-tool-tasks-')))
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

  it('builds the shell items of an ok call and of a failed call with long output byte for byte', () => {
    // Arrange
    arrange([
      ['tool_call', call('c1', { input_json: JSON.stringify({ command: 'git status --short' }) })],
      ['tool_call', call('c2', { input_json: JSON.stringify({ cmd: LONG_COMMAND }), status: 'error' })],
      ['part', result('c2', LONG_OUTPUT)],
    ])

    // Act
    const items = itemsOf(shellTask())

    // Assert
    expect(items).toStrictEqual({
      c1: '(ok)\ngit status --short',
      c2: `(FAILED)\n${LONG_COMMAND.slice(0, 1_200)}…\n--- output tail ---\n…${LONG_OUTPUT.slice(-300)}`,
    })
  })

  it('takes a ruled shell call among the shell records, and leaves a call with a rule cause out of the tool-failure ones', () => {
    // Arrange
    arrange([
      ['tool_call', call('c1', { input_json: JSON.stringify({ command: 'pnpm test' }) })],
      ['label', { ...ruleCause('c1'), name: 'purpose', value: 'run tests' }],
      ['tool_call', call('c2', { name: 'Read', bare_name: 'Read', family: 'read', status: 'error' })],
      ['part', result('c2', 'File does not exist.')],
      ['label', ruleCause('c2')],
      ['tool_call', call('c3', { name: 'Edit', bare_name: 'Edit', family: 'edit', status: 'error' })],
      ['part', result('c3', '   ')],
    ])

    // Act
    const records = { shell: Object.keys(itemsOf(shellTask())), toolFailure: Object.keys(itemsOf(toolFailureTask())) }

    // Assert
    expect(records).toStrictEqual({ shell: ['c1'], toolFailure: [] })
  })

  it('builds the tool-failure item byte for byte', () => {
    // Arrange
    const input = JSON.stringify({ file_path: '/home/example/work/shop/src/cart.ts', old_string: 'a'.repeat(500) })
    const error = `<tool_use_error>String to replace not found in file.</tool_use_error>${'b'.repeat(700)}`
    arrange([
      [
        'tool_call',
        call('c1', { name: 'Edit', bare_name: 'Edit', family: 'edit', status: 'error', input_json: input }),
      ],
      ['part', result('c1', error)],
    ])

    // Act
    const items = itemsOf(toolFailureTask())

    // Assert
    expect(items).toStrictEqual({
      c1: `tool Edit\ninput ${input.slice(0, 400)}…\n--- error ---\n${error.slice(0, 600)}…`,
    })
  })

  it("writes purpose and failure, and cause, with the run's model at versions 3 and 1", async () => {
    // Arrange
    arrange([
      ['tool_call', call('c1', { input_json: JSON.stringify({ command: 'pnpm test --filter api' }), status: 'error' })],
      ['part', result('c1', 'FAIL src/orders.test.ts')],
      ['tool_call', call('c2', { name: 'WebFetch', bare_name: 'WebFetch', family: 'web', status: 'error' })],
      ['part', result('c2', 'Request failed with status code 418')],
    ])
    const fake = await installFakeClaude(directory, {
      answers: [
        { systemPrompt: shellTask().system, answer: '2 2' },
        { systemPrompt: toolFailureTask().system, answer: '11' },
      ],
    })
    const tasks = [shellTask(), toolFailureTask()]
    const runId = opened().store.startLabelRun({
      pid: process.pid,
      startedAt: 1,
      model: MODEL,
      tasks: tasks.map((task) => ({ task: task.name, version: task.version, planned: 0 })),
    })

    // Act
    await tasks.reduce(async (previous, task) => {
      await previous
      await runLabelTask({
        store: opened().store,
        runId,
        task,
        model: MODEL,
        doneBy: 'own-model',
        claude: { binary: fake.path, cwd: directory },
        signal: new AbortController().signal,
      })
    }, Promise.resolve())

    // Assert
    const labels = opened()
      .warehouse.db.prepare(
        'SELECT record_id AS id, labeller, version, name, value FROM label ORDER BY record_id, name'
      )
      .all() as object[]
    expect(labels.map((row) => ({ ...row }))).toStrictEqual([
      { id: 'c1', labeller: MODEL, version: 3, name: 'failure', value: 'real result' },
      { id: 'c1', labeller: MODEL, version: 3, name: 'purpose', value: 'run tests' },
      { id: 'c2', labeller: MODEL, version: 1, name: 'cause', value: 'other' },
    ])
  })

  it('holds the 14 purpose codes in vocabulary order in the batch prompt', () => {
    // Act
    const prompt = renderBatchPrompt(shellTask(), [{ recordId: 'c1', text: '(ok)\nls' }])

    // Assert
    expect(prompt).toContain(
      `purpose codes:\n${SHELL_PURPOSES.map((purpose, code) => `${String(code)} = ${purpose}`).join('\n')}\n\n`
    )
  })
})
