import { WarehouseStore, type ILabelRecord } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveToolCallRules } from './tool-call-rules.js'

const SESSION = 'test-harness:s1'
const LABELS_READ =
  "SELECT record_id, labeller, version, name, value FROM label WHERE record_type = 'tool_call' ORDER BY record_id, name"

interface ICall {
  seq: number
  name: string
  family: string
  status: 'completed' | 'error'
  input?: Record<string, unknown>
  result?: string
}

const modelPurpose = (recordId: string, value: string): ILabelRecord => ({
  recordType: 'tool_call',
  recordId,
  labeller: 'model-a',
  version: 1,
  name: 'purpose',
  value,
  labelledAt: 1,
})

describe('the tool call rules pass', () => {
  let warehouse: ITestWarehouse | null = null
  let store: WarehouseStore | null = null

  const opened = (): { db: ITestWarehouse['db']; store: WarehouseStore } => {
    if (warehouse === null || store === null) {
      throw new Error('The warehouse is not open.')
    }
    return { db: warehouse.db, store }
  }

  // One session whose messages are written by actor, and its calls, numbered c0, c1, … in order.
  const session = (actors: readonly string[], calls: readonly ICall[]): void => {
    const { db } = opened()
    insert(db, 'session', {
      id: SESSION,
      harness: 'test-harness',
      source_id: 's1',
      origin: 'interactive',
      is_scripted: 0,
    })
    for (const [seq, actor] of actors.entries()) {
      insert(db, 'message', {
        id: `${SESSION}/m${String(seq)}`,
        session_id: SESSION,
        seq,
        actor,
        source_role: actor,
        created_at: seq * 1_000,
      })
    }
    for (const [index, call] of calls.entries()) {
      const id = `${SESSION}/c${String(index)}`
      insert(db, 'tool_call', {
        id,
        session_id: SESSION,
        message_id: `${SESSION}/m${String(call.seq)}`,
        name: call.name,
        bare_name: call.name,
        family: call.family,
        input_json: JSON.stringify(call.input ?? {}),
        status: call.status,
        started_at: call.seq * 1_000 + index,
      })
      if (call.result !== undefined) {
        insert(db, 'part', {
          message_id: `${SESSION}/m${String(call.seq)}`,
          session_id: SESSION,
          idx: index,
          kind: 'tool_result',
          text: call.result,
          tool_call_id: id,
        })
      }
    }
  }

  const recoveries = (): unknown[] =>
    opened()
      .store.all<{ record_id: string; value: string }>(
        "SELECT record_id, value FROM label WHERE name = 'recovery' ORDER BY record_id"
      )
      .map((row) => [row.record_id.slice(SESSION.length + 1), row.value])

  beforeEach(async () => {
    warehouse = await createTestWarehouse()
    store = await WarehouseStore.open(warehouse.path)
  })

  afterEach(async () => {
    store?.close()
    store = null
    await warehouse?.remove()
    warehouse = null
  })

  it("writes the shell purposes and the causes together, never a shell call's cause, and drops the previous sync's", () => {
    // Arrange
    session(
      ['user', 'assistant'],
      [
        {
          seq: 1,
          name: 'Bash',
          family: 'shell',
          status: 'error',
          input: { command: 'pnpm test' },
          result: 'File not found: a.sh',
        },
        {
          seq: 1,
          name: 'Read',
          family: 'read',
          status: 'error',
          result: 'File not found: /home/example/work/shop/a.ts',
        },
        { seq: 1, name: 'render', family: 'other', status: 'error', result: 'the design service returned HTTP 500' },
        { seq: 1, name: 'Grep', family: 'search', status: 'error', result: '   ' },
      ]
    )
    opened().store.writeLabels([
      {
        recordType: 'tool_call',
        recordId: `${SESSION}/c9`,
        labeller: 'rules',
        version: 1,
        name: 'cause',
        value: 'auth',
        labelledAt: 1,
      },
      {
        recordType: 'tool_call',
        recordId: `${SESSION}/c8`,
        labeller: 'rules',
        version: 2,
        name: 'purpose',
        value: 'run tests',
        labelledAt: 1,
      },
    ])

    // Act
    deriveToolCallRules(opened().store, 5_000)

    // Assert
    expect(opened().store.all(LABELS_READ)).toStrictEqual([
      { record_id: `${SESSION}/c0`, labeller: 'rules', version: 2, name: 'purpose', value: 'run tests' },
      { record_id: `${SESSION}/c0`, labeller: 'rules', version: 1, name: 'recovery', value: 'not recovered' },
      { record_id: `${SESSION}/c1`, labeller: 'rules', version: 2, name: 'cause', value: 'missing target' },
      { record_id: `${SESSION}/c1`, labeller: 'rules', version: 1, name: 'recovery', value: 'not recovered' },
      { record_id: `${SESSION}/c2`, labeller: 'rules', version: 1, name: 'recovery', value: 'not recovered' },
      { record_id: `${SESSION}/c3`, labeller: 'rules', version: 1, name: 'recovery', value: 'not recovered' },
    ])
  })

  it('counts a failure recovered only when the same tool, for the shell with the same purpose, completed later before the next prompt', () => {
    // Arrange
    session(
      ['user', 'assistant', 'assistant', 'user', 'assistant'],
      [
        { seq: 1, name: 'Bash', family: 'shell', status: 'error', input: { command: 'pnpm test' } },
        { seq: 1, name: 'Bash', family: 'shell', status: 'error', input: { command: 'git status' } },
        { seq: 2, name: 'Bash', family: 'shell', status: 'completed', input: { command: 'pnpm test --watch=false' } },
        { seq: 2, name: 'Read', family: 'read', status: 'error' },
        { seq: 4, name: 'Read', family: 'read', status: 'completed' },
      ]
    )

    // Act
    deriveToolCallRules(opened().store, 5_000)

    // Assert: the failing test run was followed by a passing one; the git call had no successor of its purpose; the
    // read succeeded only after the human's next prompt
    expect(recoveries()).toStrictEqual([
      ['c0', 'recovered'],
      ['c1', 'not recovered'],
      ['c3', 'not recovered'],
    ])
  })

  it('counts a shell purpose given only by a model', () => {
    // Arrange
    session(
      ['user', 'assistant'],
      [
        { seq: 1, name: 'Bash', family: 'shell', status: 'error', input: { command: './scripts/check.sh' } },
        { seq: 1, name: 'Bash', family: 'shell', status: 'completed', input: { command: './scripts/check.sh --fix' } },
        { seq: 1, name: 'Bash', family: 'shell', status: 'error', input: { command: './scripts/deploy.sh' } },
        { seq: 1, name: 'Bash', family: 'shell', status: 'completed', input: { command: './scripts/report.sh' } },
      ]
    )
    opened().store.writeLabels([
      modelPurpose(`${SESSION}/c0`, 'run tests'),
      modelPurpose(`${SESSION}/c1`, 'run tests'),
      modelPurpose(`${SESSION}/c2`, 'ship or deploy'),
      modelPurpose(`${SESSION}/c3`, 'read or search code'),
    ])

    // Act
    deriveToolCallRules(opened().store, 5_000)

    // Assert
    expect(recoveries()).toStrictEqual([
      ['c0', 'recovered'],
      ['c2', 'not recovered'],
    ])
  })
})
