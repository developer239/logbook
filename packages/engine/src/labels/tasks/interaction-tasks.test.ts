import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WarehouseStore } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeClaude } from '../../testing/index.js'
import { renderBatchPrompt } from '../runner/batch-prompt.js'
import { runLabelTask } from '../runner/label-runner.js'
import type { ILabelRunTask } from '../runner/label-task.js'
import { promptTask } from './prompt-task.js'
import { replyTask } from './reply-task.js'

const MODEL = 'claude-haiku-4-5'
const SESSION = 'test-harness:ses-1'
const NOW = Date.UTC(2026, 8, 28, 18)
const MINUTE = 60_000

type TRow = Record<string, string | number | null>

const id = (index: number): string => `${SESSION}/m${String(index)}`

const message = (index: number, actor: string, text: string, at: number, session = SESSION): [string, TRow][] => [
  [
    'message',
    { id: `${session}/m${String(index)}`, session_id: session, seq: index, actor, source_role: actor, created_at: at },
  ],
  ['part', { message_id: `${session}/m${String(index)}`, session_id: session, idx: 0, kind: 'text', text }],
]

const step = (callId: string, messageIndex: number, name: string, input: object, status = 'ok'): [string, TRow] => [
  'tool_call',
  {
    id: callId,
    session_id: SESSION,
    message_id: id(messageIndex),
    name,
    bare_name: name,
    family: 'other',
    input_json: JSON.stringify(input),
    status,
  },
]

// Two turns of an interactive session: a prompt, two steps and a reply, then a second prompt, a step and a reply.
const turnRows = (base: number, secondPrompt = 'run the tests before you say done'): [string, TRow][] => [
  [
    'session',
    {
      id: SESSION,
      harness: 'test-harness',
      source_id: 'ses-1',
      origin: 'interactive',
      is_scripted: 0,
      started_at: base,
    },
  ],
  ...message(0, 'user', 'add a discount code field', base + 10),
  ...message(1, 'assistant', 'Adding it.', base + 20),
  step('c1', 1, 'Read', { path: 'src/checkout.ts' }),
  step('c2', 1, 'Edit', { file_path: 'src/checkout.ts' }, 'error'),
  ...message(2, 'user', secondPrompt, base + 40),
  ...message(3, 'assistant', 'Tests pass now.', base + 50),
  step('c3', 3, 'Bash', { command: 'pnpm test' }),
]

const event = (kind: string, at: number): [string, TRow] => [
  'event',
  {
    id: `e-${kind}`,
    session_id: SESSION,
    kind,
    at,
    data_json: JSON.stringify(kind === 'interrupted' ? { messageId: id(1) } : { toolCallId: 'c2' }),
  },
]

describe('the prompt and reply tasks', () => {
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
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-interaction-tasks-')))
    warehouse = await createTestWarehouse()
    store = await WarehouseStore.open(warehouse.path)
  })

  afterEach(async () => {
    vi.useRealTimers()
    store?.close()
    store = null
    await warehouse?.remove()
    warehouse = null
    await rm(directory, { recursive: true, force: true })
  })

  it.each([
    ['an interrupted event', [event('interrupted', 30)], 'run the tests', ['[the developer interrupted the agent]']],
    ['a tool-rejected event', [event('tool-rejected', 30)], 'run the tests', ['[the developer rejected a step]']],
    ['only the interruption text, with no event', [], '[Request interrupted by user]\nrun the tests', []],
  ])('says what stopped the agent after %s', (_case, events, secondPrompt, lines) => {
    // Arrange
    arrange([...turnRows(0, secondPrompt), ...events])

    // Act
    const item = itemsOf(promptTask())[id(2)] ?? ''

    // Assert
    expect(item.split('\n').filter((line) => line.startsWith('[the developer'))).toStrictEqual(lines)
  })

  it('takes no prompt of a scripted session as a record', () => {
    // Arrange
    arrange([
      [
        'session',
        { id: 'test-harness:ses-2', harness: 'test-harness', source_id: 'ses-2', origin: 'scripted', is_scripted: 1 },
      ],
      ...message(0, 'user', 'summarise the changelog', 1, 'test-harness:ses-2'),
    ])

    // Act
    const items = { prompt: itemsOf(promptTask()), reply: itemsOf(replyTask()) }

    // Assert
    expect(items).toStrictEqual({ prompt: {}, reply: {} })
  })

  it("asks the prompt task's batch for no quote and no rule", () => {
    // Act
    const prompt = renderBatchPrompt(promptTask(), [{ recordId: id(0), text: '[start of the session]' }])

    // Assert
    expect({
      isQuoteAsked: /\bquote\b/u.test(prompt),
      isRuleAsked: /^- rule:/mu.test(prompt),
      hasEntryText: prompt.includes('#07 + 0 0 4 1 @3 |'),
    }).toStrictEqual({
      isQuoteAsked: false,
      isRuleAsked: false,
      hasEntryText: false,
    })
  })

  it("writes the act and both reactions' fields under #1 and #2, steps holding the named calls' ids", async () => {
    // Arrange
    arrange([
      ...turnRows(0),
      [
        'label',
        {
          record_type: 'message',
          record_id: id(0),
          labeller: MODEL,
          version: 2,
          name: 'act',
          value: 'task',
          labelled_at: 1,
        },
      ],
    ])
    const fake = await installFakeClaude(directory, {
      answers: [{ systemPrompt: promptTask().system, answer: '1\n{tag} + 0 0 4 1 @1\n{tag} + 4 0 2 1 @2' }],
    })
    const runId = opened().store.startLabelRun({
      pid: process.pid,
      startedAt: 1,
      model: MODEL,
      tasks: [{ task: 'prompt', version: 2, planned: 0 }],
    })

    // Act
    await runLabelTask({
      store: opened().store,
      runId,
      task: promptTask(),
      model: MODEL,
      doneBy: 'own-model',
      claude: { binary: fake.path, cwd: directory },
      signal: new AbortController().signal,
    })

    // Assert
    const labels = opened()
      .warehouse.db.prepare(
        'SELECT record_id AS id, name, value FROM label WHERE record_id LIKE ? ORDER BY record_id, name'
      )
      .all(`${id(2)}%`) as object[]
    expect(labels.map((row) => ({ ...row }))).toStrictEqual([
      { id: id(2), name: 'act', value: 'continue' },
      { id: `${id(2)}#1`, name: 'about', value: 'last turn' },
      { id: `${id(2)}#1`, name: 'reach', value: 'project' },
      { id: `${id(2)}#1`, name: 'reaction', value: 'correction' },
      { id: `${id(2)}#1`, name: 'steps', value: 'c1' },
      { id: `${id(2)}#1`, name: 'target', value: 'verification' },
      { id: `${id(2)}#2`, name: 'about', value: 'last turn' },
      { id: `${id(2)}#2`, name: 'reach', value: 'project' },
      { id: `${id(2)}#2`, name: 'reaction', value: 'praise' },
      { id: `${id(2)}#2`, name: 'steps', value: 'c2' },
      { id: `${id(2)}#2`, name: 'target', value: 'style' },
    ])
  })

  it.each([
    [30, [id(1)]],
    [61, [id(1), id(3)]],
  ])(
    "has the last turn's reply pending only once the session is quiet, earlier replies at once: %d minutes",
    (minutes, replies) => {
      // Arrange
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(NOW)
      arrange(turnRows(NOW - minutes * MINUTE - 50))

      // Act
      const pending = Object.keys(itemsOf(replyTask()))

      // Assert
      expect(pending).toStrictEqual(replies)
    }
  )

  it('builds both items byte for byte', () => {
    // Arrange
    arrange([...turnRows(0), event('interrupted', 30)])

    // Act
    const items = { prompt: itemsOf(promptTask()), reply: itemsOf(replyTask()) }

    // Assert
    const steps = ['  1. Read {"path":"src/checkout.ts"}', '  2. Edit FAILED {"file_path":"src/checkout.ts"}']
    expect(items).toStrictEqual({
      prompt: {
        [id(0)]: '[start of the session]\n[THIS PROMPT] add a discount code field',
        [id(2)]: [
          '[last prompt] add a discount code field',
          '[last turn steps]',
          ...steps,
          '[the developer interrupted the agent]',
          '[last reply] Adding it.',
          '[THIS PROMPT] run the tests before you say done',
        ].join('\n'),
      },
      reply: {
        [id(1)]: [
          "[developer's prompt] add a discount code field",
          '[steps the agent took]',
          ...steps,
          '[THE REPLY] Adding it.',
        ].join('\n'),
        [id(3)]: [
          "[agent's previous reply] Adding it.",
          "[developer's prompt] run the tests before you say done",
          '[steps the agent took]',
          '  1. Bash {"command":"pnpm test"}',
          '[THE REPLY] Tests pass now.',
        ].join('\n'),
      },
    })
  })
})
