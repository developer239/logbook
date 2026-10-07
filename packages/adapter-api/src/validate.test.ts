import type { IImportedSession } from '@log-book/warehouse'
import { describe, expect, it } from 'vitest'
import type { IHarnessDescriptor, IImportedUnit } from './contract.js'
import { validateImportedUnit } from './validate.js'

const ADAPTER_ID = 'test-harness'

const DESCRIPTOR: IHarnessDescriptor = {
  id: ADAPTER_ID,
  name: 'Test Harness',
  defaultAgent: 'build',
  unitNoun: 'sessions',
  filterAlias: 'test',
  parserVersion: 1,
  testedVersions: ['1.0'],
  locationVariables: [],
}

const TOOLS_OFFERED = {
  added: ['Read'],
  removed: [],
  surfaced: [],
  pendingServers: null,
  needsAuthServers: null,
  failedServers: [{ name: 'tracker', error: 'refused' }],
}

// A prompt, a reply that runs a shell call, and the call's result, with two events.
const validSession = (sourceId: string): IImportedSession => {
  const sessionId = `${ADAPTER_ID}:${sourceId}`
  const message = (
    id: string,
    seq: number,
    actor: 'user' | 'assistant' | 'tool'
  ): IImportedSession['messages'][number] => ({
    id: `${sessionId}/${id}`,
    sessionId,
    seq,
    actor,
    sourceRole: actor,
    createdAt: 1_000 + seq,
    completedAt: 1_100 + seq,
    requestedAt: actor === 'assistant' ? 1_000 : null,
    model: actor === 'assistant' ? 'model-a' : null,
    agent: null,
    gitBranch: 'main',
    tokensInput: null,
    tokensOutput: null,
    tokensReasoning: null,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    reportedCost: null,
  })
  return {
    session: {
      id: sessionId,
      harness: ADAPTER_ID,
      sourceId,
      origin: 'interactive',
      isScripted: false,
      projectDir: '/work/example',
      title: 'List the files',
      agent: null,
      spawnedBySessionId: null,
      spawnedByToolCallId: null,
      startedAt: 1_000,
      endedAt: 2_000,
    },
    messages: [message('m1', 0, 'user'), message('m2', 1, 'assistant'), message('m3', 2, 'tool')],
    parts: [
      { messageId: `${sessionId}/m1`, sessionId, idx: 0, kind: 'text', text: 'list the files', toolCallId: null },
      { messageId: `${sessionId}/m2`, sessionId, idx: 0, kind: 'tool_call', text: 'ls', toolCallId: `${sessionId}/c1` },
      { messageId: `${sessionId}/m3`, sessionId, idx: 0, kind: 'tool_result', text: '', toolCallId: `${sessionId}/c1` },
    ],
    toolCalls: [
      {
        id: `${sessionId}/c1`,
        sessionId,
        messageId: `${sessionId}/m2`,
        name: 'Bash',
        bareName: 'Bash',
        server: null,
        family: 'shell',
        inputJson: '{"command":"ls"}',
        status: 'completed',
        childSessionId: null,
        startedAt: 1_010,
        endedAt: 1_020,
      },
    ],
    events: [
      { id: `${sessionId}/e1`, sessionId, kind: 'tools-offered', at: 1_000, dataJson: JSON.stringify(TOOLS_OFFERED) },
      {
        id: `${sessionId}/e2`,
        sessionId,
        kind: 'skill-loaded',
        at: 1_005,
        dataJson: '{"name":"review","chars":120,"toolCallId":null}',
      },
    ],
  }
}

const validUnit = (): IImportedUnit & { sessions: IImportedSession[] } => ({
  sessions: [validSession('s1'), validSession('s2')],
  harnessVersion: '1.0.3',
})

// Builds a valid unit, lets the case break it, and validates it.
const validateBroken = (
  breakUnit: (session: IImportedSession, unit: { sessions: IImportedSession[] }) => void
): string[] => {
  const unit = validUnit()
  const [first] = unit.sessions
  if (first === undefined) {
    throw new Error('The valid unit has two sessions')
  }
  breakUnit(first, unit)
  return validateImportedUnit(DESCRIPTOR, unit)
}

// The item at index; the valid unit always holds it.
const nth = <TItem>(items: TItem[], index: number): TItem => {
  const item = items[index]
  if (item === undefined) {
    throw new Error(`The valid unit has no item ${String(index)}`)
  }
  return item
}

const S1 = `${ADAPTER_ID}:s1`

describe('validateImportedUnit', () => {
  it('returns no problem for a valid two-session unit', () => {
    // Arrange
    const unit = validUnit()

    // Act
    const problems = validateImportedUnit(DESCRIPTOR, unit)

    // Assert
    expect(problems).toStrictEqual([])
  })

  it.each([
    {
      rule: 1,
      breakUnit: (session: IImportedSession): void => {
        session.session.harness = 'another'
      },
      problem: `session ${S1}: id or harness does not match the adapter id test-harness and the source id`,
    },
    {
      rule: 2,
      breakUnit: (session: IImportedSession): void => {
        nth(session.events, 0).id = 'elsewhere/e1'
      },
      problem: 'event elsewhere/e1: id is not a child id of its session',
    },
    {
      rule: 3,
      breakUnit: (session: IImportedSession): void => {
        nth(session.events, 1).id = `${S1}/e1`
      },
      problem: `event ${S1}/e1: id is not unique in the unit`,
    },
    {
      rule: 4,
      breakUnit: (session: IImportedSession): void => {
        nth(session.parts, 0).messageId = `${S1}/m9`
      },
      problem: `part ${S1}/m9#0: messageId or sessionId does not name a message of its session`,
    },
    {
      rule: 5,
      breakUnit: (session: IImportedSession): void => {
        session.session.spawnedBySessionId = 'another:parent'
      },
      problem: `session ${S1}: spawnedBySessionId does not have the session id shape`,
    },
    {
      rule: 6,
      breakUnit: (session: IImportedSession): void => {
        nth(session.messages, 0).completedAt = 1_100.5
      },
      problem: `message ${S1}/m1: a time is not epoch milliseconds or null, or createdAt is null`,
    },
    {
      rule: 7,
      breakUnit: (session: IImportedSession): void => {
        session.session.origin = 'subagent'
      },
      problem: `session ${S1}: origin is not interactive`,
    },
    {
      rule: 8,
      breakUnit: (session: IImportedSession): void => {
        nth(session.toolCalls, 0).status = 'running' as 'pending'
      },
      problem: `tool call ${S1}/c1: status running is not a known status`,
    },
    {
      rule: 9,
      breakUnit: (session: IImportedSession): void => {
        nth(session.events, 1).dataJson = '{"name":"review"}'
      },
      problem: `event ${S1}/e2: dataJson is not a JSON document of the skill-loaded shape`,
    },
    {
      rule: 10,
      breakUnit: (session: IImportedSession): void => {
        nth(session.messages, 2).seq = 1
      },
      problem: `message ${S1}/m3: seq 1 is not unique in its session`,
    },
    {
      rule: 11,
      breakUnit: (session: IImportedSession): void => {
        nth(session.messages, 0).requestedAt = 1_000
      },
      problem: `message ${S1}/m1: requestedAt set on a user message`,
    },
    {
      rule: 12,
      breakUnit: (session: IImportedSession): void => {
        nth(session.parts, 0).text = ''
      },
      problem: `part ${S1}/m1#0: text is empty`,
    },
    {
      rule: 13,
      breakUnit: (_session: IImportedSession, unit: { sessions: IImportedSession[] }): void => {
        unit.sessions[0] = validSession(`${ADAPTER_ID}:s1`)
      },
      problem: `session ${ADAPTER_ID}:${S1}: sourceId contains the adapter id`,
    },
    {
      rule: 14,
      breakUnit: (session: IImportedSession): void => {
        nth(session.toolCalls, 0).family = 'mcp:tracker'
      },
      problem: `tool call ${S1}/c1: family mcp:tracker does not match the server null`,
    },
    {
      rule: 15,
      breakUnit: (session: IImportedSession): void => {
        nth(session.toolCalls, 0).inputJson = '{"cmd":"ls"}'
      },
      problem: `tool call ${S1}/c1: a shell call input is neither {} nor an object with a string command`,
    },
  ])('reports rule $rule once, naming the record', ({ breakUnit, problem }) => {
    // Arrange and act
    const problems = validateBroken(breakUnit)

    // Assert
    expect(problems).toStrictEqual([problem])
  })

  it('passes a tool result naming a call the unit does not hold', () => {
    // Arrange and act
    const problems = validateBroken((session) => {
      nth(session.parts, 2).toolCallId = `${S1}/c-earlier`
    })

    // Assert
    expect(problems).toStrictEqual([])
  })

  it('passes a message and an event sharing an id', () => {
    // Arrange and act
    const problems = validateBroken((session) => {
      nth(session.events, 0).id = `${S1}/m1`
    })

    // Assert
    expect(problems).toStrictEqual([])
  })

  it('passes a shell call the model never finished, with input {}', () => {
    // Arrange and act
    const problems = validateBroken((session) => {
      nth(session.toolCalls, 0).inputJson = '{}'
    })

    // Assert
    expect(problems).toStrictEqual([])
  })

  it('passes event data whose id fields hold ids, which carry the adapter id', () => {
    // Arrange and act
    const problems = validateBroken((session) => {
      nth(session.events, 0).kind = 'interrupted'
      nth(session.events, 0).dataJson = JSON.stringify({ messageId: `${S1}/m1` })
    })

    // Assert
    expect(problems).toStrictEqual([])
  })

  it("passes the adapter id in the harness's own data, where a user may name either agent", () => {
    // Arrange and act
    const problems = validateBroken((session) => {
      session.session.title = `Compare ${ADAPTER_ID} with the other agent`
      session.session.projectDir = `/work/${ADAPTER_ID}-setup`
      nth(session.parts, 0).text = `Why does ${ADAPTER_ID} skip this session?`
      nth(session.toolCalls, 0).inputJson = JSON.stringify({ command: `grep -r ${ADAPTER_ID} .` })
      nth(session.events, 1).dataJson = JSON.stringify({ name: `${ADAPTER_ID} review`, chars: 120, toolCallId: null })
    })

    // Assert
    expect(problems).toStrictEqual([])
  })

  it('passes an mcp family that matches the call server', () => {
    // Arrange and act
    const problems = validateBroken((session) => {
      nth(session.toolCalls, 0).family = 'mcp:tracker'
      nth(session.toolCalls, 0).server = 'tracker'
      nth(session.toolCalls, 0).inputJson = '{"query":"open"}'
    })

    // Assert
    expect(problems).toStrictEqual([])
  })
})
