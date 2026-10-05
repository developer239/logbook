import { ERROR_CODES } from '@log-book/core'
import { WarehouseStore } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { WarehouseQueries } from './queries.js'
import { readOperations } from './read.js'
import { REPORT_NAMES, REPORT_TOPICS, type ReportName } from './report-names.js'
import { REPORTS } from './reports.js'

type TRow = Record<string, string | number | null>

const T0 = Date.UTC(2026, 8, 1, 10)
const MAIN = 'test-harness:main'
const CHILD = 'test-harness:child'
const OTHER = 'other-harness:ses_example01'

const session = (id: string, fields: Partial<TRow> = {}): TRow => ({
  id,
  harness: id.slice(0, id.indexOf(':')),
  source_id: id.slice(id.indexOf(':') + 1),
  origin: 'interactive',
  is_scripted: 0,
  project_dir: '/home/example/work/shop',
  title: `Title of ${id}`,
  started_at: T0,
  ended_at: T0 + 600_000,
  ...fields,
})

const message = (sessionId: string, seq: number, actor: string, fields: Partial<TRow> = {}): TRow => ({
  id: `${sessionId}/m${String(seq)}`,
  session_id: sessionId,
  seq,
  actor,
  source_role: actor,
  created_at: T0 + seq * 1_000,
  ...fields,
})

const call = (id: string, sessionId: string, messageId: string, fields: Partial<TRow> = {}): TRow => ({
  id,
  session_id: sessionId,
  message_id: messageId,
  name: 'Read',
  bare_name: 'Read',
  family: 'read',
  input_json: '{"path":"src/cart.ts"}',
  status: 'ok',
  started_at: T0 + 2_000,
  ended_at: T0 + 3_000,
  ...fields,
})

const event = (id: string, sessionId: string, kind: string, data: unknown = {}): TRow => ({
  id,
  session_id: sessionId,
  kind,
  at: T0 + 5_000,
  data_json: JSON.stringify(data),
})

const label = (recordType: string, recordId: string, name: string, value: string, labeller = 'model-a'): TRow => ({
  record_type: recordType,
  record_id: recordId,
  labeller,
  version: 1,
  name,
  value,
  labelled_at: 1,
})

const command = (sessionId: string, at: number, name: string, hasFile: number): TRow => ({
  session_id: sessionId,
  message_id: `${sessionId}/m0`,
  at,
  command: name,
  source: 'typed',
  has_file: hasFile,
})

// Rows every report reads: two harnesses' sessions, a subagent, messages with tokens, calls of several families with
// failures, events, commands, a turn, and model and rule labels.
const everyReportsRows = (): [string, TRow][] => {
  const prompt = `${MAIN}/m0`
  const reply = `${MAIN}/m1`
  return [
    ['session', session(MAIN)],
    ['session', session(CHILD, { origin: 'subagent', started_at: T0 + 2_000 })],
    ['session', session(OTHER, { project_dir: '/home/example/work/billing' })],
    ['message', message(MAIN, 0, 'user')],
    [
      'message',
      message(MAIN, 1, 'assistant', {
        model: 'model-one',
        requested_at: T0 + 1_000,
        completed_at: T0 + 9_000,
        tokens_input: 900,
        tokens_output: 300,
        tokens_cache_read: 100,
      }),
    ],
    ['message', message(CHILD, 0, 'assistant', { model: 'model-one', tokens_output: 40 })],
    ['part', { message_id: prompt, session_id: MAIN, idx: 0, kind: 'text', text: 'keep the saved cart' }],
    [
      'part',
      { message_id: reply, session_id: MAIN, idx: 0, kind: 'tool_result', text: 'No such file', tool_call_id: 'c1' },
    ],
    ['tool_call', call('c1', MAIN, reply, { status: 'error' })],
    ['tool_call', call('c2', MAIN, reply, { status: 'error' })],
    ['tool_call', call('c3', MAIN, reply)],
    [
      'tool_call',
      call('c4', MAIN, reply, {
        name: 'Bash',
        bare_name: 'Bash',
        family: 'shell',
        input_json: '{"command":"pnpm test"}',
      }),
    ],
    [
      'tool_call',
      call('c5', MAIN, reply, {
        name: 'Skill',
        bare_name: 'Skill',
        family: 'skill',
        input_json: '{"skill":"review-checklist"}',
      }),
    ],
    ['event', event('e1', MAIN, 'error', { error: 'API Error: Connection dropped.' })],
    ['event', event('e2', MAIN, 'compaction')],
    ['event', event('e3', MAIN, 'interrupted', { messageId: reply })],
    [
      'link',
      {
        parent_session_id: MAIN,
        parent_tool_call_id: 'c3',
        child_session_id: CHILD,
        kind: 'subagent',
        confidence: 'exact',
        evidence: 'reported',
      },
    ],
    ['session_command', command(MAIN, T0, '/review', 1)],
    [
      'turn',
      {
        session_id: MAIN,
        message_id: prompt,
        seq: 0,
        is_prompt: 1,
        requests: 1,
        tool_calls: 5,
        started_at: T0,
        ended_at: T0 + 9_000,
        model_ms: 5_000,
        tool_ms: 3_000,
        idle_ms: 1_000,
        human_wait_ms: 0,
      },
    ],
    ['label', label('session', MAIN, 'goal', 'build a feature')],
    ['label', label('session', MAIN, 'outcome', 'done')],
    ['label', label('tool_call', 'c4', 'purpose', 'test', 'rules')],
    ['label', label('tool_call', 'c1', 'cause', 'missing target', 'rules')],
    ['label', label('tool_call', 'c1', 'recovery', 'recovered', 'rules')],
    ['label', label('message', prompt, 'act', 'task')],
    ['label', label('reaction', `${prompt}#1`, 'reaction', 'correction')],
    ['label', label('reaction', `${prompt}#1`, 'target', 'code')],
    ['label', label('reaction', `${prompt}#1`, 'reach', 'once')],
    ['label', label('reaction', `${prompt}#1`, 'steps', 'c1')],
    ['label', label('message', reply, 'reply', 'asks,permission')],
  ]
}

// A report's rows on an opened warehouse, as objects.
const run = async (opened: ITestWarehouse, name: ReportName): Promise<Record<string, unknown>[]> => {
  const reader = await WarehouseStore.openReadOnly(opened.path)
  try {
    const result = new WarehouseQueries(reader).query(REPORTS[name].sql, 200)
    return result.rows.map((row) => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])))
  } finally {
    reader.close()
  }
}

// The titles of a report answer, in its order.
const titlesOf = (answer: string): string[] =>
  answer
    .split('\n')
    .filter((line) => line.startsWith('# '))
    .map((line) => line.slice(2))

describe('the reports', () => {
  let warehouse: ITestWarehouse | null = null

  const open = async (rows: readonly [string, TRow][]): Promise<ITestWarehouse> => {
    warehouse = await createTestWarehouse()
    for (const [table, row] of rows) {
      insert(warehouse.db, table, row)
    }
    return warehouse
  }

  afterEach(async () => {
    await warehouse?.remove()
    warehouse = null
  })

  it('runs every report on a warehouse holding the rows it reads, each returning its columns', async () => {
    // Arrange
    const opened = await open(everyReportsRows())

    // Act
    const counts = await Promise.all(
      REPORT_NAMES.map(async (name) => ({ name, rows: (await run(opened, name)).length }))
    )
    const empty = counts.filter(({ rows }) => rows === 0).map(({ name }) => name)

    // Assert
    expect(empty).toStrictEqual([])
  })

  it('holds the 28 reports in the order all prints them, each under its topic', () => {
    // Act
    const byTopic = Object.fromEntries(
      REPORT_TOPICS.map((topic) => [topic, REPORT_NAMES.filter((name) => REPORTS[name].topic === topic)])
    )

    // Assert
    expect({ count: REPORT_NAMES.length, byTopic }).toStrictEqual({
      count: 28,
      byTopic: {
        failures: ['tool-failures', 'errors', 'shell', 'tool-causes', 'repeats', 'interrupts', 'recovery'],
        performance: ['tools', 'slow', 'latency', 'turn-time', 'longest-turns', 'heavy', 'output', 'context'],
        usage: ['skills', 'commands', 'families', 'models', 'daily'],
        sessions: ['calls', 'chains', 'work', 'goals', 'outcomes', 'links'],
        interaction: ['reactions', 'replies'],
      },
    })
  })

  it("holds no harness id, run, work type, quote or rule in any report's SQL", () => {
    // Act
    const offending = REPORT_NAMES.filter((name) =>
      /'claude-code'|'opencode'|harness = '|\brun\b|work_type|\bquote\b|'rule'/u.test(REPORTS[name].sql)
    )

    // Assert
    expect(offending).toStrictEqual([])
  })

  it('times a request from its request to its completion less its tool calls, clipped to that span', async () => {
    // Arrange
    const first = 'test-harness:latency'
    const second = 'other-harness:latency'
    const opened = await open([
      ['session', session(first)],
      ['session', session(second)],
      [
        'message',
        message(first, 0, 'assistant', {
          model: 'model-one',
          requested_at: T0,
          completed_at: T0 + 10_000,
          tokens_output: 600,
        }),
      ],
      [
        'message',
        message(first, 1, 'assistant', {
          model: 'model-one',
          requested_at: T0,
          completed_at: T0 + 700_000,
          tokens_output: 5,
        }),
      ],
      [
        'message',
        message(second, 0, 'assistant', {
          model: 'model-two',
          requested_at: T0 + 1_000,
          completed_at: T0 + 11_000,
          tokens_output: 400,
        }),
      ],
      // Two overlapping calls, counted once: 4 seconds off.
      ['tool_call', call('l1', first, `${first}/m0`, { started_at: T0 + 2_000, ended_at: T0 + 5_000 })],
      ['tool_call', call('l2', first, `${first}/m0`, { started_at: T0 + 4_000, ended_at: T0 + 6_000 })],
      // Started before the request: only the 2 seconds inside it are taken off.
      ['tool_call', call('l3', second, `${second}/m0`, { started_at: T0 - 1_000, ended_at: T0 + 3_000 })],
    ])

    // Act
    const rows = await run(opened, 'latency')

    // Assert
    expect(rows).toStrictEqual([
      {
        harness: 'test-harness',
        model: 'model-one',
        requests: 1,
        p50_s: 6,
        p90_s: 6,
        out_tokens_per_s: 100,
        over_10min: 1,
      },
      {
        harness: 'other-harness',
        model: 'model-two',
        requests: 1,
        p50_s: 8,
        p90_s: 8,
        out_tokens_per_s: 50,
        over_10min: 0,
      },
    ])
  })

  it('counts interrupted and tool-rejected events, not a prompt that only reads like an interruption', async () => {
    // Arrange
    const opened = await open([
      ['session', session(MAIN)],
      ['session', session(OTHER)],
      ['message', message(MAIN, 0, 'user')],
      [
        'part',
        { message_id: `${MAIN}/m0`, session_id: MAIN, idx: 0, kind: 'text', text: '[Request interrupted by user]' },
      ],
      ['event', event('i1', MAIN, 'interrupted', { messageId: `${MAIN}/m0` })],
      ['event', event('i2', MAIN, 'interrupted', { messageId: `${MAIN}/m0` })],
      ['event', event('i3', OTHER, 'interrupted', { messageId: 'm' })],
      ['event', event('r1', OTHER, 'tool-rejected', { toolCallId: 'c' })],
    ])

    // Act
    const rows = (await run(opened, 'interrupts')).map(({ harness, kind, count, sessions }) => ({
      harness,
      kind,
      count,
      sessions,
    }))

    // Assert
    expect(rows).toStrictEqual([
      { harness: 'test-harness', kind: 'interrupted', count: 2, sessions: 1 },
      { harness: 'other-harness', kind: 'interrupted', count: 1, sessions: 1 },
      { harness: 'other-harness', kind: 'tool-rejected', count: 1, sessions: 1 },
    ])
  })

  it('groups work by the first command with a command file each session ran', async () => {
    // Arrange
    const opened = await open([
      ['session', session(MAIN)],
      ['session', session(OTHER)],
      ['session_command', command(MAIN, T0, '/model', 0)],
      ['session_command', command(MAIN, T0 + 1_000, '/review', 1)],
      ['session_command', command(MAIN, T0 + 2_000, '/ship', 1)],
      ['session_command', command(OTHER, T0, '/review', 1)],
    ])

    // Act
    const rows = (await run(opened, 'work')).map(({ command: name, sessions }) => ({ command: name, sessions }))

    // Assert
    expect(rows).toStrictEqual([{ command: '/review', sessions: 2 }])
  })
})

describe('engine.read.report', () => {
  let warehouse: ITestWarehouse | null = null

  afterEach(async () => {
    await warehouse?.remove()
    warehouse = null
  })

  it.each([
    ['a report name', 'chains', ['Sessions that started the most others']],
    ['a topic', 'interaction', ['How the human reacted to the agent', 'What the agent did in its replies']],
    ['all', 'all', REPORT_NAMES.map((name) => REPORTS[name].title)],
  ])('prints the reports of %s with their titles and descriptions', async (_case, selector, titles) => {
    // Arrange
    warehouse = await createTestWarehouse()

    // Act
    const answer = await readOperations(warehouse.path).report(selector)

    // Assert
    expect({ titles: titlesOf(answer), hasDescription: answer.includes(REPORTS.chains.description) }).toStrictEqual({
      titles,
      hasDescription: selector !== 'interaction',
    })
  })

  it('refuses an unknown selector, listing the topics and the reports', async () => {
    // Arrange
    warehouse = await createTestWarehouse()

    // Act
    const answering = readOperations(warehouse.path).report('speed')

    // Assert
    await expect(answering).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: `Unknown report speed. Topics: ${REPORT_TOPICS.join(', ')}. Reports: ${REPORT_NAMES.join(', ')}.`,
    })
  })
})
