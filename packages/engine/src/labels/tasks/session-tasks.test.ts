import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WarehouseStore } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeClaude, type IFakeClaude } from '../../testing/index.js'
import { runLabelTask } from '../runner/label-runner.js'
import type { ILabelRunTask } from '../runner/label-task.js'
import { outcomeTask } from './outcome-task.js'
import { sessionTask } from './session-task.js'

const MODEL = 'claude-haiku-4-5'
const SESSION = 'test-harness:ses-1'
const NOW = Date.UTC(2026, 8, 28, 18)
const MINUTE = 60_000

type TRow = Record<string, string | number | null>

const message = (index: number, actor: string, text: string, createdAt: number): [string, TRow][] => [
  [
    'message',
    {
      id: `${SESSION}/m${String(index)}`,
      session_id: SESSION,
      seq: index,
      actor,
      source_role: actor,
      created_at: createdAt,
    },
  ],
  ['part', { message_id: `${SESSION}/m${String(index)}`, session_id: SESSION, idx: 0, kind: 'text', text }],
]

// An invented harness and session, with the session's first command.
const HEADER_ROWS: [string, TRow][] = [
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
    {
      id: SESSION,
      harness: 'test-harness',
      source_id: 'ses-1',
      origin: 'interactive',
      is_scripted: 0,
      project_dir: '/home/example/work/shop',
      title: 'Keep the saved cart',
      agent: 'build',
      started_at: 1,
      ended_at: 2,
    },
  ],
  [
    'session_command',
    { session_id: SESSION, message_id: `${SESSION}/m0`, at: 1, command: '/review', source: 'typed', has_file: 1 },
  ],
]

// The session with a harness message and an image-only prompt among its prompts, ending in a failed request.
const sessionRows = (newest: number): [string, TRow][] => [
  ...HEADER_ROWS,
  ...message(0, 'user', 'keep the saved cart\n   after sign-in', 1),
  ...message(1, 'harness', 'Instructions loaded.', 2),
  ...message(2, 'user', '(image)', 3),
  ...message(3, 'assistant', 'Looking at the cart.', 4),
  ...message(4, 'user', 'also check the badge', 5),
  ...message(5, 'assistant', 'Done: the cart stays.', newest - 1),
  [
    'event',
    {
      id: 'e1',
      session_id: SESSION,
      kind: 'error',
      at: newest,
      data_json: JSON.stringify({ error: 'API Error: Connection dropped.' }),
    },
  ],
]

const goalLabel = (name: string, value: string): TRow => ({
  record_type: 'session',
  record_id: SESSION,
  labeller: 'model-a',
  version: 2,
  name,
  value,
  labelled_at: 1,
})

describe('the session and outcome tasks', () => {
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

  // The session task, then the outcome task, in one run.
  const runBoth = async (fake: IFakeClaude): Promise<void> => {
    const tasks = [sessionTask(), outcomeTask()]
    const runId = opened().store.startLabelRun({
      pid: process.pid,
      startedAt: 1,
      model: MODEL,
      tasks: tasks.map((task) => ({ task: task.name, version: task.version, planned: 0 })),
    })
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
  }

  const fakeAnswering = async (sessionAnswer: string, outcomeAnswer: string): Promise<IFakeClaude> =>
    installFakeClaude(directory, {
      answers: [
        { systemPrompt: sessionTask().system, promptIncludes: 'secondGoal codes:', answer: sessionAnswer },
        { systemPrompt: outcomeTask().system, promptIncludes: 'outcome codes:', answer: outcomeAnswer },
      ],
    })

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-session-tasks-')))
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

  it('builds both items byte for byte, naming the harness by its display name and never by its id', () => {
    // Arrange
    arrange([
      ...sessionRows(100),
      ['label', goalLabel('goal', 'build a feature')],
      ['label', goalLabel('secondGoal', 'review')],
      ['label', goalLabel('summary', 'kept the saved cart')],
    ])

    // Act
    const items = { session: itemsOf(sessionTask())[SESSION], outcome: itemsOf(outcomeTask())[SESSION] }

    // Assert
    expect(items).toStrictEqual({
      session: [
        'origin interactive, harness Test Harness, agent build, project shop, title Keep the saved cart, command /review',
        '[prompt 1] keep the saved cart after sign-in',
        '[prompt 2] also check the badge',
        '[last reply] Done: the cart stays.',
      ].join('\n'),
      outcome: [
        'origin interactive, harness Test Harness, agent build, project shop, 6 messages, goal build a feature then review, summary kept the saved cart',
        '[ask] keep the saved cart after sign-in',
        '[last prompt] also check the badge',
        '[reply before] Looking at the cart.',
        '[last reply] Done: the cart stays.',
        '[ended with a failed model request] API Error: Connection dropped.',
      ].join('\n'),
    })
    expect(Object.values(items).some((text) => text?.includes('test-harness'))).toBe(false)
  })

  it('reads no harness message as a prompt and skips an image-only prompt', () => {
    // Arrange
    arrange([
      ...HEADER_ROWS,
      ...message(1, 'harness', 'Instructions loaded.', 2),
      ...message(2, 'user', '(image)', 3),
      ...message(3, 'assistant', 'Looking at the cart.', 4),
    ])

    // Act
    const items = { session: itemsOf(sessionTask()), outcome: itemsOf(outcomeTask()) }

    // Assert
    expect(items).toStrictEqual({ session: {}, outcome: {} })
  })

  it.each([
    [59, false],
    [61, true],
  ])('has the outcome pending only once the newest message is an hour old: %d minutes', (minutes, isPending) => {
    // Arrange
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    arrange(sessionRows(NOW - minutes * MINUTE))

    // Act
    const isPendingNow = SESSION in itemsOf(outcomeTask())

    // Assert
    expect(isPendingNow).toBe(isPending)
  })

  it('reads into the outcome item the goals the session task wrote in the same run', async () => {
    // Arrange
    arrange(sessionRows(100))
    const fake = await fakeAnswering('0 2 | kept the saved cart', '0 | cart kept')

    // Act
    await runBoth(fake)

    // Assert
    const outcomePrompt = (await fake.readRecords())
      .map((record) => record.stdin)
      .find((stdin) => stdin.includes('outcome codes:'))
    expect(outcomePrompt).toContain('goal build a feature then fix a bug, summary kept the saved cart')
  })

  it('writes goal, secondGoal, summary, outcome and outcomeNote, and no row for a - text', async () => {
    // Arrange
    arrange(sessionRows(100))
    const fake = await fakeAnswering('0 0 | kept the saved cart', '0 | -')

    // Act
    await runBoth(fake)

    // Assert
    const labels = opened()
      .warehouse.db.prepare('SELECT name, value, version FROM label WHERE labeller = ? ORDER BY name')
      .all(MODEL) as object[]
    expect(labels.map((row) => ({ ...row }))).toStrictEqual([
      { name: 'goal', value: 'build a feature', version: 2 },
      { name: 'outcome', value: 'done', version: 1 },
      { name: 'secondGoal', value: 'none', version: 2 },
      { name: 'summary', value: 'kept the saved cart', version: 2 },
    ])
  })
})
