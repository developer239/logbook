import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ERROR_CODES } from '@log-book/core'
import { WarehouseStore } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeClaude, type IFakeClaude, type IFakeClaudeScenario } from '../testing/index.js'
import { planLabelling, type LabelPlan } from './plan.js'
import { runLabelTask } from './runner/label-runner.js'
import { labelRunTasks } from './tasks/all-tasks.js'

const MAIN = 'test-harness:main'
const OTHER = 'other-harness:ses_example01'

type TRow = Record<string, string | number | null>

const harness = (id: string, name: string): [string, TRow] => [
  'harness',
  { id, name, default_agent: 'build', filter_alias: id, is_found: 1, checked_at: 1, location_variables: '[]' },
]

const session = (id: string): [string, TRow] => [
  'session',
  {
    id,
    harness: id.slice(0, id.indexOf(':')),
    source_id: id.slice(id.indexOf(':') + 1),
    origin: 'interactive',
    is_scripted: 0,
    started_at: 1,
  },
]

const message = (sessionId: string, seq: number, actor: string, text: string): [string, TRow][] => [
  [
    'message',
    { id: `${sessionId}/m${String(seq)}`, session_id: sessionId, seq, actor, source_role: actor, created_at: seq + 1 },
  ],
  ['part', { message_id: `${sessionId}/m${String(seq)}`, session_id: sessionId, idx: 0, kind: 'text', text }],
]

const shellCall = (id: string, sessionId: string): [string, TRow] => [
  'tool_call',
  {
    id,
    session_id: sessionId,
    message_id: `${sessionId}/m1`,
    name: 'Bash',
    bare_name: 'Bash',
    family: 'shell',
    input_json: JSON.stringify({ command: `ls ${id}` }),
    status: 'ok',
  },
]

// Two harnesses' sessions: shell calls, a failed call for the tool-failure task, prompts and replies.
const RECORDS: [string, TRow][] = [
  harness('test-harness', 'Test Harness'),
  harness('other-harness', 'Other Harness'),
  session(MAIN),
  session(OTHER),
  ...message(MAIN, 0, 'user', 'add a discount code field'),
  ...message(MAIN, 1, 'assistant', 'Adding it.'),
  ...message(MAIN, 2, 'user', 'run the tests'),
  ...message(MAIN, 3, 'assistant', 'They pass.'),
  ...message(OTHER, 0, 'user', 'fix the invoice rounding'),
  ...message(OTHER, 1, 'assistant', 'Fixed.'),
  shellCall('c1', MAIN),
  shellCall('c2', MAIN),
  shellCall('c4', OTHER),
  [
    'tool_call',
    {
      id: 'c3',
      session_id: MAIN,
      message_id: `${MAIN}/m1`,
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
      message_id: `${MAIN}/m1`,
      session_id: MAIN,
      idx: 1,
      kind: 'tool_result',
      text: 'File does not exist.',
      tool_call_id: 'c3',
    },
  ],
]

describe('planLabelling', () => {
  let directory = ''
  let warehouse: ITestWarehouse | null = null

  const opened = (): ITestWarehouse => {
    if (warehouse === null) {
      throw new Error('The warehouse is not open.')
    }
    return warehouse
  }

  const install = async (scenario: IFakeClaudeScenario = {}): Promise<IFakeClaude> => {
    const bin = join(directory, 'bin')
    await mkdir(bin, { recursive: true })
    const fake = await installFakeClaude(bin, scenario)
    vi.stubEnv('PATH', bin)
    return fake
  }

  const plan = async (model?: string): Promise<LabelPlan> =>
    planLabelling({ warehousePath: opened().path, ...(model === undefined ? {} : { model }) })

  const rowCounts = (): Record<string, number> =>
    Object.fromEntries(
      (
        opened()
          .db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'part_fts%'")
          .all() as { name: string }[]
      ).map(({ name }) => [
        name,
        (opened().db.prepare(`SELECT count(*) AS count FROM ${name}`).get() as { count: number }).count,
      ])
    )

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-plan-')))
    vi.stubEnv('CLAUDE_BIN', '')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    warehouse = await createTestWarehouse()
    for (const [table, row] of RECORDS) {
      insert(warehouse.db, table, row)
    }
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await warehouse?.remove()
    warehouse = null
    await rm(directory, { recursive: true, force: true })
  })

  it('returns the facts with the counts of the records and the estimate from the rates', async () => {
    // Arrange
    await install()

    // Act
    const result = await plan()

    // Assert
    expect(result).toStrictEqual({
      status: 'ready',
      facts: {
        model: 'claude-haiku-4-5',
        claudeVersion: '2.1.286',
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        apiKeyInEnvironment: false,
        tasks: [
          { task: 'shell', records: 3 },
          { task: 'tool-failure', records: 1 },
          { task: 'session', records: 2 },
          { task: 'outcome', records: 2 },
          { task: 'prompt', records: 3 },
          { task: 'reply', records: 3 },
        ],
        harnesses: [
          { id: 'other-harness', name: 'Other Harness', records: 5 },
          { id: 'test-harness', name: 'Test Harness', records: 9 },
        ],
        records: 14,
        estimatedInputTokens: 3 * 200 + 330 + 2 * 530 + 2 * 510 + 3 * 1800 + 3 * 1700,
      },
    })
  })

  it('lists a task with nothing pending at 0 and leaves out a harness with nothing pending', async () => {
    // Arrange
    await install()
    insert(opened().db, 'label', {
      record_type: 'tool_call',
      record_id: 'c3',
      labeller: 'claude-sonnet-5-5',
      version: 1,
      name: 'cause',
      value: 'missing target',
      labelled_at: 1,
    })
    insert(opened().db, ...harness('idle-harness', 'Idle Harness'))

    // Act
    const result = await plan()

    // Assert
    const facts = result.status === 'ready' ? result.facts : null
    expect({ toolFailure: facts?.tasks[1], harnesses: facts?.harnesses.map(({ id }) => id) }).toStrictEqual({
      toolFailure: { task: 'tool-failure', records: 0 },
      harnesses: ['other-harness', 'test-harness'],
    })
  })

  it('takes no lock, writes nothing and runs only the two detection calls', async () => {
    // Arrange
    const fake = await install()
    const before = rowCounts()

    // Act
    await plan()

    // Assert
    expect({
      lockFiles: [existsSync(`${opened().path}.lock`), existsSync(`${opened().path}.labels.lock`)],
      rows: rowCounts(),
      calls: (await fake.readRecords()).map(({ argv }) => argv),
    }).toStrictEqual({ lockFiles: [false, false], rows: before, calls: [['--version'], ['auth', 'status', '--json']] })
  })

  it('ends signed out as a missing prerequisite, names the model given, and refuses -x before detection', async () => {
    // Arrange
    const signedOut = await install({ auth: { loggedIn: false } })

    // Act
    const missing = await plan()
    const refusing = plan('-x')
    await expect(refusing).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR })
    const callsAfterRefusal = (await signedOut.readRecords()).length
    await install()
    const sonnet = await plan('claude-sonnet-5-5')

    // Assert
    expect({ missing, callsAfterRefusal, model: sonnet.status === 'ready' ? sonnet.facts.model : null }).toStrictEqual({
      missing: { status: 'missing', missing: { kind: 'not-signed-in' } },
      callsAfterRefusal: 2,
      model: 'claude-sonnet-5-5',
    })
  })

  it('counts what a run started right after it plans for every task', async () => {
    // Arrange
    const fake = await install({
      answers: [
        { systemPrompt: 'You label shell commands', answer: '0 0' },
        { systemPrompt: 'You label failed tool calls', answer: '0' },
        { systemPrompt: 'You label conversations', promptIncludes: 'secondGoal codes:', answer: '0 0 | added a field' },
        { systemPrompt: 'You label conversations', promptIncludes: 'outcome codes:', answer: '0 | done' },
        { systemPrompt: 'You label conversations', promptIncludes: 'act codes:', answer: '0' },
        { systemPrompt: 'You label conversations', promptIncludes: 'reply codes:', answer: '0 | -' },
      ],
    })
    const result = await plan()
    const store = await WarehouseStore.open(opened().path)
    const tasks = labelRunTasks()
    const runId = store.startLabelRun({
      pid: process.pid,
      startedAt: 1,
      model: 'claude-haiku-4-5',
      tasks: tasks.map((task) => ({ task: task.name, version: task.version, planned: 0 })),
    })

    // Act
    const planned = await tasks.reduce<Promise<{ task: string; records: number }[]>>(async (previous, task) => {
      const counted = await previous
      const run = await runLabelTask({
        store,
        runId,
        task,
        model: 'claude-haiku-4-5',
        doneBy: 'any-model',
        claude: { binary: fake.path, cwd: directory },
        signal: new AbortController().signal,
      })
      return [...counted, { task: task.name, records: run.planned }]
    }, Promise.resolve([]))
    store.close()

    // Assert
    expect(planned).toStrictEqual(result.status === 'ready' ? result.facts.tasks : null)
  })
})
