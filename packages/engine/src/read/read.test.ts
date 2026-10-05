import { ERROR_CODES } from '@log-book/core'
import { WAREHOUSE_ERROR_CODES } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readOperations, type IReadOperations } from './read.js'

const PARENT = 'test-harness:parent'
const CHILD = 'test-harness:child'
const GRANDCHILD = 'test-harness:grandchild'
const OTHER = 'other-harness:ses_example01'
const T0 = Date.UTC(2026, 8, 1, 10)

type TRow = Record<string, string | number | null>

const harnessRow = (id: string, alias: string): TRow => ({
  id,
  name: id,
  default_agent: 'main',
  filter_alias: alias,
  is_found: 1,
  checked_at: T0,
  location_variables: '[]',
})

const sessionRow = (id: string, fields: Partial<TRow> = {}): TRow => ({
  id,
  harness: id.split(':')[0] ?? '',
  source_id: id.split(':')[1] ?? '',
  origin: 'interactive',
  is_scripted: 0,
  project_dir: '/home/example/work/shop',
  title: `Title of ${id}`,
  started_at: T0,
  ended_at: T0 + 60_000,
  ...fields,
})

const messageRow = (sessionId: string, seq: number, actor: string): TRow => ({
  id: `${sessionId}/m${String(seq)}`,
  session_id: sessionId,
  seq,
  actor,
  source_role: actor,
  created_at: T0 + seq * 1_000,
})

const partRow = (
  messageId: string,
  idx: number,
  kind: string,
  text: string,
  toolCallId: string | null = null
): TRow => ({
  message_id: messageId,
  session_id: messageId.slice(0, messageId.lastIndexOf('/')),
  idx,
  kind,
  text,
  tool_call_id: toolCallId,
})

const linkRow = (parent: string, child: string): TRow => ({
  parent_session_id: parent,
  parent_tool_call_id: `${parent}/c1`,
  child_session_id: child,
  kind: 'subagent',
  confidence: 'exact',
  evidence: 'the subagent tool call reported the child session',
})

const sessionLabel = (recordId: string, name: string, value: string): TRow => ({
  record_type: 'session',
  record_id: recordId,
  labeller: 'model-a',
  version: 1,
  name,
  value,
  labelled_at: 1,
})

// The session ids of a sessions answer, in its order.
const idsOf = (answer: string): string[] =>
  [...answer.matchAll(/^\| (?<id>[a-z-]+:[\w-]+) \|/gmu)].map((match) => match.groups?.id ?? '')

// FTS5 marks a matched phrase as one span.
const hits = (answer: string): string[] => answer.split('\n').filter((line) => line.includes('[walrus checkout]'))

// The session lines of a tree answer, without their statistics.
const linesOf = (answer: string): string[] =>
  answer
    .split('\n')
    .filter((line) => line.trimStart().startsWith('- '))
    .map((line) => line.replace(/\) .*$/u, ')'))

describe('engine.read', () => {
  let warehouse: ITestWarehouse | null = null
  let read: IReadOperations | null = null

  const reads = (): IReadOperations => {
    if (read === null) {
      throw new Error('The warehouse is not open.')
    }
    return read
  }

  beforeEach(async () => {
    warehouse = await createTestWarehouse()
    const { db } = warehouse
    const rows: [string, TRow][] = [
      ['harness', harnessRow('test-harness', 'invented')],
      ['harness', harnessRow('other-harness', 'other')],
      ['session', sessionRow(PARENT, { started_at: T0 + 3_000 })],
      ['session', sessionRow(CHILD, { origin: 'subagent', started_at: T0 + 4_000, title: null })],
      ['session', sessionRow(GRANDCHILD, { origin: 'subagent', started_at: T0 + 5_000 })],
      ['session', sessionRow(OTHER, { origin: 'scripted', is_scripted: 1, project_dir: '/home/example/work/billing' })],
      ['message', messageRow(PARENT, 0, 'user')],
      ['message', messageRow(PARENT, 1, 'harness')],
      ['message', messageRow(PARENT, 2, 'assistant')],
      ['part', partRow(`${PARENT}/m0`, 0, 'text', 'add a discount code field to the walrus checkout')],
      ['part', partRow(`${PARENT}/m1`, 0, 'text', 'Instructions loaded.')],
      ['part', partRow(`${PARENT}/m2`, 0, 'tool_call', 'Read {"path":"src/checkout.ts"}', `${PARENT}/c1`)],
      ['part', partRow(`${PARENT}/m2`, 1, 'text', 'The walrus checkout has the field now.')],
      [
        'tool_call',
        {
          id: `${PARENT}/c1`,
          session_id: PARENT,
          message_id: `${PARENT}/m2`,
          name: 'Read',
          bare_name: 'Read',
          family: 'read',
          input_json: '{"path":"src/checkout.ts"}',
          status: 'error',
          started_at: T0 + 2_000,
          ended_at: T0 + 2_500,
        },
      ],
      ['message', messageRow(OTHER, 0, 'user')],
      ['part', partRow(`${OTHER}/m0`, 0, 'text', 'fix the invoice rounding')],
      ['link', linkRow(PARENT, CHILD)],
      ['link', linkRow(CHILD, GRANDCHILD)],
      ['label', sessionLabel(PARENT, 'goal', 'build a feature')],
      ['label', sessionLabel(PARENT, 'outcome', 'done')],
      ['label', sessionLabel(OTHER, 'goal', 'review')],
      ['label', sessionLabel(OTHER, 'secondGoal', 'fix a bug')],
      ['label', sessionLabel(OTHER, 'outcome', 'blocked')],
    ]
    for (const [table, row] of rows) {
      insert(db, table, row)
    }
    read = readOperations(warehouse.path)
  })

  afterEach(async () => {
    await warehouse?.remove()
    warehouse = null
    read = null
  })

  it.each<[string, Parameters<IReadOperations['sessions']>[0], string[]]>([
    ['no filter, newest first', {}, [GRANDCHILD, CHILD, PARENT, OTHER]],
    ['the harness by its adapter id', { harness: 'other-harness' }, [OTHER]],
    ['the harness by its filter alias', { harness: 'invented' }, [GRANDCHILD, CHILD, PARENT]],
    ['an origin', { origin: 'scripted' }, [OTHER]],
    ['a text in the project directory', { project: 'billing' }, [OTHER]],
    ['a first goal', { goal: 'build a feature' }, [PARENT]],
    ['a second goal', { goal: 'fix a bug' }, [OTHER]],
    ['an outcome', { outcome: 'blocked' }, [OTHER]],
    ['sessions since a time', { since: T0 + 4_000 }, [GRANDCHILD, CHILD]],
    ['the limit', { limit: 2 }, [GRANDCHILD, CHILD]],
  ])('lists the sessions for %s', async (_case, filter, ids) => {
    // Act
    const answer = await reads().sessions(filter)

    // Assert
    expect(idsOf(answer)).toStrictEqual(ids)
  })

  it.each([
    [
      'an unknown harness',
      { harness: 'missing' },
      'No harness missing in the warehouse; pass an adapter id or its filter alias.',
    ],
    ['an unknown origin', { origin: 'robot' }, 'No origin robot; pass one of interactive, scripted, subagent.'],
  ])('refuses %s', async (_case, filter, message) => {
    // Act
    const answering = reads().sessions(filter)

    // Assert
    await expect(answering).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR, message })
  })

  it('finds a phrase and keeps to its limit', async () => {
    // Act
    const [all, one] = [
      await reads().search('"walrus checkout"'),
      await reads().search('"walrus checkout"', { limit: 1 }),
    ]

    // Assert
    expect({
      all: hits(all).length,
      one: hits(one).length,
      inSession: hits(all).every((line) => line.includes(PARENT)),
    }).toStrictEqual({
      all: 2,
      one: 1,
      inSession: true,
    })
  })

  it('shows the tree from a child, and from its root', async () => {
    // Act
    const [fromChild, fromRoot] = [await reads().tree(CHILD), await reads().tree(CHILD, { isFromRoot: true })]

    // Assert
    expect({ fromChild: linesOf(fromChild), fromRoot: linesOf(fromRoot) }).toStrictEqual({
      fromChild: [`- ${CHILD} (subagent)`, `  - subagent [exact] -> ${GRANDCHILD} (subagent)`],
      fromRoot: [
        `- ${PARENT} (interactive)`,
        `  - subagent [exact] via Read -> ${CHILD} (subagent)`,
        `    - subagent [exact] -> ${GRANDCHILD} (subagent)`,
      ],
    })
  })

  it('shows a timeline of prompts, answers and calls without harness messages', async () => {
    // Act
    const answer = await reads().timeline(PARENT)

    // Assert
    const rows = answer.split('\n').filter((line) => line.startsWith('| 2026'))
    expect(rows.map((row) => row.split(' | ').slice(1, 4))).toStrictEqual([
      ['user', 'text', '-'],
      ['assistant', 'Read (failed)', '1s'],
      ['assistant', 'text', '-'],
    ])
  })

  it('takes a session by the id its harness shows, and refuses an ambiguous or unknown id', async () => {
    // Arrange
    insert(warehouse?.db ?? (null as never), 'session', sessionRow('other-harness:parent', { source_id: 'parent' }))

    // Act
    const [byHarnessId, ambiguous, unknown] = await Promise.all([
      reads().timeline('ses_example01'),
      reads()
        .timeline('parent')
        .catch((error: unknown) => error),
      reads()
        .timeline('ses_missing')
        .catch((error: unknown) => error),
    ])

    // Assert
    expect({ byHarnessId: byHarnessId.split('\n')[0], ambiguous, unknown }).toMatchObject({
      byHarnessId: `# Timeline: ${OTHER}`,
      ambiguous: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'Session id parent matches 2 sessions; pass the warehouse id.',
      },
      unknown: {
        code: ERROR_CODES.NOT_FOUND,
        message: 'No session ses_missing in the warehouse. Run logbook sync, or check the id.',
      },
    })
  })

  it('returns SQL rows, cut at maxRows', async () => {
    // Act
    const answer = await reads().sql('SELECT id, origin FROM session ORDER BY id', { maxRows: 2 })

    // Assert
    expect(answer.split('\n').filter((line) => line !== '')).toStrictEqual([
      '# Query',
      '| id | origin |',
      '| --- | --- |',
      `| ${OTHER} | scripted |`,
      `| ${CHILD} | subagent |`,
      '_Showing the first 2 rows._',
    ])
  })

  it("fails a write statement with SQLite's message and changes nothing", async () => {
    // Act
    const writing = reads().sql("INSERT INTO forgotten (session_id, forgotten_at) VALUES ('x', 1)")

    // Assert
    await expect(writing).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'SQL failed: attempt to write a readonly database',
    })
    expect(warehouse?.db.prepare('SELECT count(*) AS count FROM forgotten').get()).toMatchObject({ count: 0 })
  })

  it('refuses a warehouse at another version', async () => {
    // Arrange
    const old = await createTestWarehouse({ version: 0 })

    // Act
    const answering = readOperations(old.path).sessions()

    // Assert
    try {
      await expect(answering).rejects.toMatchObject({ code: WAREHOUSE_ERROR_CODES.WAREHOUSE_SCHEMA_MISMATCH })
    } finally {
      await old.remove()
    }
  })
})
