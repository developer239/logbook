import type { MessageActor } from '@log-book/warehouse'
import { WarehouseStore } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveTurns, measureTurn, type ITurnMessage, type ITurnTool } from './turn-time.js'

const SECOND = 1000

const message = (id: string, actor: MessageActor, createdAt: number, completedAt: number | null): ITurnMessage => ({
  id,
  actor,
  createdAt: createdAt * SECOND,
  completedAt: completedAt === null ? null : completedAt * SECOND,
})

const tool = (family: string, startedAt: number, endedAt: number): ITurnTool => ({
  family,
  startedAt: startedAt * SECOND,
  endedAt: endedAt * SECOND,
})

describe('measureTurn', () => {
  it('counts the wait for the model from when the session was ready, and a wait on the human or a silent stretch as idle', () => {
    // Arrange: a turn whose transcript stamps a request only as it streams
    const messages = [
      message('m0', 'user', 0, null),
      message('m1', 'assistant', 5, 6),
      message('m2', 'assistant', 12, 13),
      message('m3', 'assistant', 75, 76),
      // nothing recorded for 15 minutes after the CI monitor ended: idle, not the model
      message('m4', 'assistant', 2176, 2178),
    ]
    const tools = [tool('shell', 6, 10), tool('question', 13, 73), tool('shell', 76, 1276)]

    // Act
    const time = measureTurn(messages, tools)

    // Assert: model [0,6] [10,13] [73,76] [2176,2178]; tools [6,10] [76,1276]; idle the question and the silence
    expect(time).toStrictEqual({
      startedAt: 0,
      endedAt: 2178 * SECOND,
      modelMs: 14 * SECOND,
      toolMs: 1204 * SECOND,
      idleMs: 960 * SECOND,
      humanWaitMs: 60 * SECOND,
    })
  })

  it('takes tool time and a silent wait out of a message that stays open across them', () => {
    // Arrange: one request open from 1 s to 1000 s, a tool at 700 s, a permission prompt waiting before it
    const messages = [message('m0', 'user', 0, null), message('m1', 'assistant', 1, 1000)]

    // Act
    const time = measureTurn(messages, [tool('read', 700, 710)])

    // Assert: model [0,1] and [710,1000]; the 699 s with nothing recorded is idle
    expect(time).toStrictEqual({
      startedAt: 0,
      endedAt: 1000 * SECOND,
      modelMs: 291 * SECOND,
      toolMs: 10 * SECOND,
      idleMs: 699 * SECOND,
      humanWaitMs: 0,
    })
  })

  it('ends a turn at the last thing the agent did, not at a harness message nothing answered', () => {
    // Arrange: a resume three hours later appends a harness message to the turn
    const messages = [
      message('m0', 'user', 0, null),
      message('m1', 'assistant', 2, 5),
      message('m2', 'harness', 10_800, null),
    ]

    // Act
    const time = measureTurn(messages, [tool('read', 5, 6)])

    // Assert
    expect(time).toStrictEqual({
      startedAt: 0,
      endedAt: 6 * SECOND,
      modelMs: 5 * SECOND,
      toolMs: SECOND,
      idleMs: 0,
      humanWaitMs: 0,
    })
  })
})

describe('deriveTurns', () => {
  let warehouse: ITestWarehouse | null = null
  let store: WarehouseStore | null = null

  const opened = (): { db: ITestWarehouse['db']; store: WarehouseStore } => {
    if (warehouse === null || store === null) {
      throw new Error('The warehouse is not open.')
    }
    return { db: warehouse.db, store }
  }

  // A session whose messages are written by actor, one second apart, each completed when the next starts.
  const session = (id: string, actors: readonly MessageActor[], startAt = 0): void => {
    insert(opened().db, 'session', {
      id,
      harness: 'test-harness',
      source_id: id,
      origin: 'interactive',
      is_scripted: 0,
    })
    for (const [seq, actor] of actors.entries()) {
      insert(opened().db, 'message', {
        id: `${id}/m${String(seq)}`,
        session_id: id,
        seq,
        actor,
        source_role: actor,
        created_at: (startAt + seq) * SECOND,
        completed_at: actor === 'assistant' ? (startAt + seq + 1) * SECOND : null,
      })
    }
  }

  // The session's one call, made by the message at messageSeq.
  const call = (sessionId: string, messageSeq: number, family: string, startedAt: number, endedAt: number): void => {
    insert(opened().db, 'tool_call', {
      id: `${sessionId}/c1`,
      session_id: sessionId,
      message_id: `${sessionId}/m${String(messageSeq)}`,
      name: family,
      bare_name: family,
      family,
      input_json: '{}',
      status: 'completed',
      started_at: startedAt * SECOND,
      ended_at: endedAt * SECOND,
    })
  }

  const turns = (): unknown[] =>
    opened().store.all(
      'SELECT session_id, message_id, seq, is_prompt, requests, tool_calls, human_wait_ms, parent_turn_id, parent_tool_call_id FROM turn ORDER BY session_id, seq'
    )

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

  it("starts a turn at every user message, and at a session's first message whoever wrote it", () => {
    // Arrange
    session('test-harness:two-prompts', ['user', 'assistant', 'user', 'assistant', 'assistant'])
    session('test-harness:opens-with-harness', ['harness', 'assistant', 'user'])

    // Act
    deriveTurns(opened().store)

    // Assert
    expect(
      opened().store.all('SELECT message_id, seq, is_prompt, requests FROM turn ORDER BY session_id, seq')
    ).toStrictEqual([
      { message_id: 'test-harness:opens-with-harness/m0', seq: 0, is_prompt: 0, requests: 1 },
      { message_id: 'test-harness:opens-with-harness/m2', seq: 1, is_prompt: 1, requests: 0 },
      { message_id: 'test-harness:two-prompts/m0', seq: 0, is_prompt: 1, requests: 1 },
      { message_id: 'test-harness:two-prompts/m2', seq: 1, is_prompt: 1, requests: 2 },
    ])
  })

  it("places a subagent session's first turn under the parent turn that holds its starting call", () => {
    // Arrange
    session('test-harness:parent', ['user', 'assistant', 'user', 'assistant'])
    call('test-harness:parent', 3, 'subagent', 3.5, 9)
    session('test-harness:child', ['user', 'assistant'], 4)
    insert(opened().db, 'link', {
      parent_session_id: 'test-harness:parent',
      parent_tool_call_id: 'test-harness:parent/c1',
      child_session_id: 'test-harness:child',
      kind: 'subagent',
      confidence: 'exact',
      evidence: 'the subagent tool call reported the child session',
    })

    // Act
    deriveTurns(opened().store)

    // Assert
    expect(turns()).toMatchObject([
      {
        message_id: 'test-harness:child/m0',
        parent_turn_id: 'test-harness:parent/m2',
        parent_tool_call_id: 'test-harness:parent/c1',
      },
      { message_id: 'test-harness:parent/m0', parent_turn_id: null, parent_tool_call_id: null },
      { message_id: 'test-harness:parent/m2', parent_turn_id: null, parent_tool_call_id: null, tool_calls: 1 },
    ])
  })

  it('gives a session with no incoming link no placement', () => {
    // Arrange
    session('test-harness:alone', ['user', 'assistant'])

    // Act
    deriveTurns(opened().store)

    // Assert
    expect(turns()).toMatchObject([
      { message_id: 'test-harness:alone/m0', parent_turn_id: null, parent_tool_call_id: null },
    ])
  })

  it("counts a question call's time as human wait", () => {
    // Arrange
    session('test-harness:asks', ['user', 'assistant'])
    call('test-harness:asks', 1, 'question', 1.5, 1.75)

    // Act
    deriveTurns(opened().store)

    // Assert
    expect(turns()).toMatchObject([{ message_id: 'test-harness:asks/m0', human_wait_ms: 250 }])
  })
})
