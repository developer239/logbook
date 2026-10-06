import type { ISqliteDb } from '@log-book/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { everything, label, message, session, START, toolCall } from '../testing/rows'
import { insert, seedWarehouse, type ITestWarehouse } from '../testing/warehouse'
import { MINUTE, SECOND } from '../time'
import type * as Calls from './calls'
import type * as PluginsView from './plugins-view'
import type * as Problems from './problems'
import type * as Session from './session'
import type * as Steps from './steps'
import type * as ToolTokens from './tool-tokens'

const USUAL_CALLS = 20
const LONG_MS = 60 * MINUTE

// One call of every kind a family or a server decides, each with 20 quick runs and one very long one, so a slow one
// would show; the only call that may be slow is the plain one.
const KINDS: readonly { name: string; family: string; server?: string; purpose?: string }[] = [
  { name: 'fetch_page', family: 'other' },
  { name: 'Dispatch', family: 'dispatch' },
  { name: 'Wait', family: 'wait' },
  { name: 'wait_runs', family: 'wait', server: 'runner' },
  { name: 'Task', family: 'subagent' },
  { name: 'bash', family: 'shell', purpose: 'wait for something' },
]

// A session per harness id, invented: one that recorded the tools it was offered and one that did not.
const seed = (db: ISqliteDb): void => {
  for (const id of ['first:demo-0001', 'second:demo-0001', 'second:demo-0002']) {
    session(db, {
      id,
      harness: id.split(':')[0] ?? '',
      origin: 'interactive',
      title: id,
      startedAt: START,
      endedAt: START + 2 * LONG_MS,
    })
    message(db, { id: `${id}/m1`, sessionId: id, seq: 0, actor: 'user', at: START, text: 'Go' })
    message(db, { id: `${id}/m2`, sessionId: id, seq: 1, actor: 'assistant', at: START + SECOND, text: 'On it' })
  }
  const call = (id: string, kind: (typeof KINDS)[number], durationMs: number, at: number): void => {
    toolCall(db, {
      id,
      sessionId: 'first:demo-0001',
      messageId: 'first:demo-0001/m2',
      name: kind.server === undefined ? kind.name : `mcp__${kind.server}__${kind.name}`,
      bareName: kind.name,
      ...(kind.server === undefined ? {} : { server: kind.server }),
      family: kind.family,
      startedAt: at,
      durationMs,
    })
    if (kind.purpose !== undefined) {
      label(db, { recordType: 'tool_call', recordId: id, labeller: 'rules', name: 'purpose', value: kind.purpose })
    }
  }
  KINDS.forEach((kind, index) => {
    for (let run = 0; run < USUAL_CALLS; run += 1) {
      call(`${kind.name}-${String(run)}`, kind, SECOND, START + index * MINUTE + run * SECOND)
    }
    call(`${kind.name}-long`, kind, LONG_MS, START + LONG_MS)
  })
  toolCall(db, {
    id: 'tracker-1',
    sessionId: 'second:demo-0001',
    messageId: 'second:demo-0001/m2',
    name: 'mcp__tracker__create_issue',
    bareName: 'create_issue',
    server: 'tracker',
    family: 'mcp:tracker',
    startedAt: START + 2 * SECOND,
  })
  toolCall(db, {
    id: 'dispatch-failed',
    sessionId: 'second:demo-0002',
    messageId: 'second:demo-0002/m2',
    name: 'Dispatch',
    family: 'dispatch',
    status: 'error',
    startedAt: START + 3 * SECOND,
  })
  label(db, {
    recordType: 'tool_call',
    recordId: 'dispatch-failed',
    labeller: 'rules',
    name: 'cause',
    value: 'aborted',
  })
  insert(db, 'event', {
    id: 'second:demo-0002/offered',
    session_id: 'second:demo-0002',
    kind: 'tools-offered',
    at: START,
    data_json: JSON.stringify({
      added: ['mcp__tracker__create_issue'],
      removed: [],
      surfaced: [],
      pendingServers: null,
      needsAuthServers: null,
      failedServers: null,
    }),
  })
  for (const [id, at] of [
    ['first:demo-0001/skill-1', START + MINUTE],
    ['second:demo-0001/skill-1', START + 2 * MINUTE],
  ] as const) {
    insert(db, 'event', {
      id,
      session_id: id.split('/')[0] ?? '',
      kind: 'skill-loaded',
      at,
      data_json: JSON.stringify({ name: 'writing', chars: 400, toolCallId: null }),
    })
  }
}

let warehouse: ITestWarehouse
let calls: typeof Calls
let tokens: typeof ToolTokens
let plugins: typeof PluginsView
let problems: typeof Problems
let sessions: typeof Session
let steps: typeof Steps

beforeAll(async () => {
  warehouse = await seedWarehouse(seed)
  calls = await import('./calls')
  tokens = await import('./tool-tokens')
  plugins = await import('./plugins-view')
  problems = await import('./problems')
  sessions = await import('./session')
  steps = await import('./steps')
})

afterAll(async () => {
  await warehouse.remove()
})

describe('tools by their recorded server and name', () => {
  it('groups a call under the server it recorded, by its name without the server', () => {
    // Act
    const tracker = tokens.toolTokens(everything()).filter((row) => row.source.kind === 'plugin')

    // Assert
    expect(tracker.map((row) => [row.source.name, row.name])).toStrictEqual([
      ['runner', 'wait_runs'],
      ['tracker', 'create_issue'],
    ])
  })

  it('lists a dispatch or wait call without a server under its own name with the harness tools', () => {
    // Act
    const builtIn = tokens
      .toolTokens(everything())
      .filter((row) => row.source.kind === 'built-in')
      .map((row) => row.name)

    // Assert
    expect(builtIn.toSorted()).toStrictEqual(['Dispatch', 'Task', 'Wait', 'bash', 'fetch_page'])
  })

  it("names a session's called plugin tool by its server in the plugin block", () => {
    // Act
    const view = plugins.sessionPlugins(sessions.sessionCache(), 'second:demo-0001')

    // Assert
    expect(view).toStrictEqual({
      offers: 'unknown',
      definitions: 'unrecorded',
      plugins: [{ plugin: 'tracker', tools: [{ name: 'create_issue', calls: 1, definitionTokens: null }] }],
    })
  })

  it('shows the offered tools of a session that recorded them, whatever its harness', () => {
    // Act
    const offered = plugins.sessionPlugins(sessions.sessionCache(), 'second:demo-0002')
    const called = plugins.sessionPlugins(sessions.sessionCache(), 'first:demo-0001')

    // Assert
    expect([offered.offers, called.offers]).toStrictEqual(['recorded', 'unknown'])
  })
})

describe('slow calls by family', () => {
  it('never counts a dispatch, wait, subagent or waiting shell call as slow, however long it ran', () => {
    // Act
    const { groups } = calls.slowCalls(everything())

    // Assert
    expect(groups.map((group) => group.key)).toStrictEqual(['fetch_page'])
  })

  it('lists none of those calls as slow on /steps, and the long plain call as the only one', () => {
    // Arrange
    const query = { failed: false, cause: null, real: false, loop: false, tool: null }

    // Act
    const totals = ['fetch_page', 'Dispatch', 'Wait', 'wait_runs', 'Task', 'bash · wait for something'].map(
      (key) => steps.steps({ ...query, slow: key }, everything(), 0).total
    )

    // Assert
    expect(totals).toStrictEqual([1, 0, 0, 0, 0, 0])
  })
})

describe('skill loads', () => {
  it('counts each skill-loaded event as a load with its chars, whether a call loaded it or not', () => {
    // Act
    const writing = tokens.toolTokens(everything()).find((row) => row.source.kind === 'skills')

    // Assert
    expect(writing).toMatchObject({ name: 'writing', calls: 2, typicalTokens: 100, totalTokens: 200 })
  })
})

describe('tool problems', () => {
  it('counts a failed dispatch call under its cause, with no list of tools you maintain', () => {
    // Act
    const found = problems.toolProblems(everything())

    // Assert
    expect({
      keys: Object.keys(found).toSorted(),
      aborted: found.causes.find((cause) => cause.cause === 'Stopped before finishing')?.tools,
    }).toStrictEqual({ keys: ['causes', 'failed', 'realResults'], aborted: ['Dispatch'] })
  })
})
