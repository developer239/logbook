import { WarehouseStore } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveInitiators, deriveLinks } from './links.js'

const LINKS_READ =
  'SELECT parent_session_id, parent_tool_call_id, child_session_id, kind, confidence, evidence FROM link ORDER BY child_session_id'

const sessionRow = (
  id: string,
  fields: { isScripted?: number; spawnedBy?: string; spawnedByCall?: string } = {}
): Record<string, string | number | null> => ({
  id,
  harness: 'test-harness',
  source_id: id.slice('test-harness:'.length),
  origin: 'interactive',
  is_scripted: fields.isScripted ?? 0,
  spawned_by_session_id: fields.spawnedBy ?? null,
  spawned_by_tool_call_id: fields.spawnedByCall ?? null,
})

const callRow = (
  id: string,
  sessionId: string,
  fields: { family?: string; child?: string } = {}
): Record<string, string | number | null> => ({
  id,
  session_id: sessionId,
  message_id: `${sessionId}/m1`,
  name: fields.family === 'dispatch' ? 'start_run' : 'Task',
  bare_name: fields.family === 'dispatch' ? 'start_run' : 'Task',
  family: fields.family ?? 'subagent',
  input_json: '{}',
  status: 'completed',
  child_session_id: fields.child ?? null,
})

// The result a call recorded, as its tool_result part.
const resultPart = (callId: string, text: string): Record<string, string | number | null> => ({
  message_id: 'test-harness:caller/m1',
  session_id: 'test-harness:caller',
  idx: 0,
  kind: 'tool_result',
  text,
  tool_call_id: callId,
})

describe('the link and initiator passes', () => {
  let warehouse: ITestWarehouse | null = null
  let store: WarehouseStore | null = null

  const opened = (): { db: ITestWarehouse['db']; store: WarehouseStore } => {
    if (warehouse === null || store === null) {
      throw new Error('The warehouse is not open.')
    }
    return { db: warehouse.db, store }
  }

  const rows = (table: string, sessionRows: readonly Record<string, string | number | null>[]): void => {
    for (const row of sessionRows) {
      insert(opened().db, table, row)
    }
  }

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

  it("links a call naming a stored child with the call's id", () => {
    // Arrange
    rows('session', [sessionRow('test-harness:parent'), sessionRow('test-harness:child')])
    rows('tool_call', [callRow('test-harness:parent/c1', 'test-harness:parent', { child: 'test-harness:child' })])

    // Act
    deriveLinks(opened().store)

    // Assert
    expect(opened().store.all(LINKS_READ)).toStrictEqual([
      {
        parent_session_id: 'test-harness:parent',
        parent_tool_call_id: 'test-harness:parent/c1',
        child_session_id: 'test-harness:child',
        kind: 'subagent',
        confidence: 'exact',
        evidence: 'the subagent tool call reported the child session',
      },
    ])
  })

  it('links a child named only by its session, and a child named both ways once', () => {
    // Arrange
    rows('session', [
      sessionRow('test-harness:parent'),
      sessionRow('test-harness:by-session', {
        spawnedBy: 'test-harness:parent',
        spawnedByCall: 'test-harness:parent/c9',
      }),
      sessionRow('test-harness:both', { spawnedBy: 'test-harness:parent' }),
    ])
    rows('tool_call', [callRow('test-harness:parent/c1', 'test-harness:parent', { child: 'test-harness:both' })])

    // Act
    deriveLinks(opened().store)

    // Assert
    expect(opened().store.all(LINKS_READ)).toStrictEqual([
      {
        parent_session_id: 'test-harness:parent',
        parent_tool_call_id: 'test-harness:parent/c1',
        child_session_id: 'test-harness:both',
        kind: 'subagent',
        confidence: 'exact',
        evidence: 'the subagent tool call reported the child session',
      },
      {
        parent_session_id: 'test-harness:parent',
        parent_tool_call_id: 'test-harness:parent/c9',
        child_session_id: 'test-harness:by-session',
        kind: 'subagent',
        confidence: 'exact',
        evidence: 'the subagent session records its parent session',
      },
    ])
  })

  it('gives no link to a child whose parent is not stored, or to a call whose child is not', () => {
    // Arrange
    rows('session', [
      sessionRow('test-harness:orphan', { spawnedBy: 'test-harness:deleted' }),
      sessionRow('test-harness:parent'),
    ])
    rows('tool_call', [callRow('test-harness:parent/c1', 'test-harness:parent', { child: 'test-harness:missing' })])

    // Act
    deriveLinks(opened().store)

    // Assert
    expect(opened().store.all(LINKS_READ)).toStrictEqual([])
  })

  it('sets the origin from is_scripted, and subagent for a linked child even when it is scripted', () => {
    // Arrange
    rows('session', [
      sessionRow('test-harness:person'),
      sessionRow('test-harness:program', { isScripted: 1 }),
      sessionRow('test-harness:child', { isScripted: 1, spawnedBy: 'test-harness:person' }),
    ])

    // Act
    deriveLinks(opened().store)

    // Assert
    expect(opened().store.all('SELECT id, origin FROM session ORDER BY id')).toStrictEqual([
      { id: 'test-harness:child', origin: 'subagent' },
      { id: 'test-harness:person', origin: 'interactive' },
      { id: 'test-harness:program', origin: 'scripted' },
    ])
  })

  it('links a dispatch call to the one session its result or input names, and makes that session scripted', () => {
    // Arrange
    rows('session', [
      sessionRow('test-harness:caller'),
      sessionRow('test-harness:ses_example01'),
      sessionRow('test-harness:ses_example02'),
    ])
    rows('tool_call', [
      callRow('test-harness:caller/c1', 'test-harness:caller', { family: 'dispatch' }),
      {
        ...callRow('test-harness:caller/c2', 'test-harness:caller', { family: 'dispatch' }),
        input_json: '{"sessionId":"ses_example01"}',
      },
    ])
    rows('part', [resultPart('test-harness:caller/c1', 'Run started.\nSession ID: ses_example01')])

    // Act
    deriveLinks(opened().store)

    // Assert
    expect({
      links: opened().store.all(LINKS_READ),
      origins: opened().store.all('SELECT id, origin FROM session ORDER BY id'),
    }).toStrictEqual({
      links: ['test-harness:caller/c1', 'test-harness:caller/c2'].map((call) => ({
        parent_session_id: 'test-harness:caller',
        parent_tool_call_id: call,
        child_session_id: 'test-harness:ses_example01',
        kind: 'dispatch',
        confidence: 'reconstructed',
        evidence: "the dispatch call's input or result names the child session",
      })),
      origins: [
        { id: 'test-harness:caller', origin: 'interactive' },
        { id: 'test-harness:ses_example01', origin: 'scripted' },
        { id: 'test-harness:ses_example02', origin: 'interactive' },
      ],
    })
  })

  it("marks each of several sessions a dispatch call names ambiguous, leaving out the call's own and a subagent", () => {
    // Arrange
    rows('session', [
      sessionRow('test-harness:caller'),
      sessionRow('test-harness:ses_example01'),
      sessionRow('test-harness:ses_example02'),
      sessionRow('test-harness:ses_example03', { spawnedBy: 'test-harness:caller' }),
    ])
    rows('tool_call', [callRow('test-harness:caller/c1', 'test-harness:caller', { family: 'dispatch' })])
    rows('part', [
      resultPart('test-harness:caller/c1', 'From caller: ses_example01 and ses_example02 ran, ses_example03 helped.'),
    ])

    // Act
    deriveLinks(opened().store)

    // Assert
    expect({
      dispatches: opened()
        .store.all<{ child_session_id: string; kind: string; confidence: string }>(LINKS_READ)
        .filter((link) => link.kind === 'dispatch')
        .map((link) => [link.child_session_id, link.confidence]),
      origins: opened().store.all('SELECT id, origin FROM session ORDER BY id'),
    }).toStrictEqual({
      dispatches: [
        ['test-harness:ses_example01', 'ambiguous'],
        ['test-harness:ses_example02', 'ambiguous'],
      ],
      origins: [
        { id: 'test-harness:caller', origin: 'interactive' },
        { id: 'test-harness:ses_example01', origin: 'interactive' },
        { id: 'test-harness:ses_example02', origin: 'interactive' },
        { id: 'test-harness:ses_example03', origin: 'subagent' },
      ],
    })
  })

  it('labels the initiator human for an interactive session and agent otherwise, keeping only its own rows', () => {
    // Arrange
    rows('session', [
      sessionRow('test-harness:person'),
      sessionRow('test-harness:program', { isScripted: 1 }),
      sessionRow('test-harness:child', { spawnedBy: 'test-harness:person' }),
    ])
    deriveLinks(opened().store)
    opened().store.writeLabels([
      {
        recordType: 'session',
        recordId: 'test-harness:person',
        labeller: 'rules',
        version: 1,
        name: 'stale',
        value: 'old rule',
        labelledAt: 1,
      },
      {
        recordType: 'session',
        recordId: 'test-harness:person',
        labeller: 'model-a',
        version: 1,
        name: 'outcome',
        value: 'done',
        labelledAt: 1,
      },
    ])

    // Act
    deriveInitiators(opened().store, 1_000)
    deriveInitiators(opened().store, 2_000)

    // Assert
    expect(
      opened().store.all(
        'SELECT record_id, labeller, version, name, value, labelled_at FROM label ORDER BY labeller, record_id'
      )
    ).toStrictEqual([
      {
        record_id: 'test-harness:person',
        labeller: 'model-a',
        version: 1,
        name: 'outcome',
        value: 'done',
        labelled_at: 1,
      },
      {
        record_id: 'test-harness:child',
        labeller: 'rules',
        version: 1,
        name: 'initiator',
        value: 'agent',
        labelled_at: 2_000,
      },
      {
        record_id: 'test-harness:person',
        labeller: 'rules',
        version: 1,
        name: 'initiator',
        value: 'human',
        labelled_at: 2_000,
      },
      {
        record_id: 'test-harness:program',
        labeller: 'rules',
        version: 1,
        name: 'initiator',
        value: 'agent',
        labelled_at: 2_000,
      },
    ])
  })
})
