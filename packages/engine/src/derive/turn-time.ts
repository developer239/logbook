import type { ITurnRecord, MessageActor, WarehouseStore } from '@log-book/warehouse'
import { placeTurns, type IPlacementCall, type IPlacementLink } from './turn-placement.js'

// A stretch with nothing recorded for this long is idle, not the model. Measured on real sessions: the model's waits
// were all under 2 minutes (median 0.4), and the longer ones were a session waiting on background tasks, a permission
// prompt or a sleeping machine.
const TURN_IDLE_GAP_MS = 10 * 60 * 1000

export interface ITurnMessage {
  id: string
  actor: MessageActor
  createdAt: number
  completedAt: number | null
}

export interface ITurnTool {
  family: string
  startedAt: number | null
  endedAt: number | null
}

export interface ITurnTime {
  startedAt: number
  endedAt: number
  modelMs: number
  toolMs: number
  idleMs: number
  // The part of idleMs a tool spent waiting for the human to answer.
  humanWaitMs: number
}

type TInterval = readonly [number, number]

// Tools that wait for the human to answer: the time they take is the human's, not the agent's.
const HUMAN_WAIT_FAMILIES: ReadonlySet<string> = new Set(['question'])

// Overlapping intervals merged, in order.
const union = (intervals: readonly TInterval[]): TInterval[] =>
  intervals
    .filter(([start, end]) => end > start)
    .toSorted((left, right) => left[0] - right[0])
    .reduce<TInterval[]>((merged, interval) => {
      const last = merged.at(-1)
      if (last !== undefined && interval[0] <= last[1]) {
        merged[merged.length - 1] = [last[0], Math.max(last[1], interval[1])]
        return merged
      }
      return [...merged, interval]
    }, [])

// What of `intervals` (merged) lies outside `cut` (merged).
const subtract = (intervals: readonly TInterval[], cut: readonly TInterval[]): TInterval[] =>
  intervals.flatMap(([start, end]) => {
    const pieces: TInterval[] = []
    let from = start
    for (const [cutStart, cutEnd] of cut) {
      if (cutEnd > from && cutStart < end) {
        if (cutStart > from) {
          pieces.push([from, cutStart])
        }
        from = Math.max(from, cutEnd)
      }
    }
    return from < end ? [...pieces, [from, end] as const] : pieces
  })

const lengthOf = (intervals: readonly TInterval[]): number =>
  intervals.reduce((total, [start, end]) => total + end - start, 0)

const endOf = (message: ITurnMessage): number => message.completedAt ?? message.createdAt

// The end of the last thing the agent did in a turn: its model requests, tool calls and tool results. A harness
// message after them (a resumed session's "Continue from where you left off.", a notification nothing answered) does
// not extend the turn; one that woke the agent is followed by a request that ends later. A turn with nothing from the
// agent ends where it began.
const turnEnd = (messages: readonly ITurnMessage[], tools: readonly ITurnTool[]): number => {
  let end = messages[0]?.createdAt ?? 0
  for (const message of messages) {
    if (message.actor === 'assistant' || message.actor === 'tool') {
      end = Math.max(end, endOf(message))
    }
  }
  for (const tool of tools) {
    if (tool.startedAt !== null) {
      end = Math.max(end, tool.endedAt ?? tool.startedAt)
    }
  }
  return end
}

// Model time: each request runs from when the session was ready (the last message or tool call that ended before the
// request's first output: a transcript may stamp a request only as it streams) to its end, outside tool and human
// time, cut at every recorded moment; a piece with nothing recorded for TURN_IDLE_GAP_MS is idle instead.
const modelTimeOf = (
  messages: readonly ITurnMessage[],
  timed: readonly TInterval[],
  startedAt: number,
  outside: readonly TInterval[]
): TInterval[] => {
  const stepEnds = [
    ...messages.map((message) => (message.actor === 'assistant' ? endOf(message) : message.createdAt)),
    ...timed.map((interval) => interval[1]),
  ]
  const requests = messages
    .filter((message) => message.actor === 'assistant')
    .map((message): TInterval => {
      const ready = Math.max(startedAt, ...stepEnds.filter((end) => end <= message.createdAt))
      return [message.createdAt - ready >= TURN_IDLE_GAP_MS ? message.createdAt : ready, endOf(message)]
    })
  const moments = [
    ...new Set([...messages.flatMap((message) => [message.createdAt, endOf(message)]), ...timed.flat()]),
  ].toSorted((left, right) => left - right)
  return subtract(union(requests), union(outside))
    .flatMap(([start, end]) => {
      const cuts = [start, ...moments.filter((at) => at > start && at < end), end]
      return cuts.slice(1).map((cut, index): TInterval => [cuts[index] ?? start, cut])
    })
    .filter(([start, end]) => end - start < TURN_IDLE_GAP_MS)
}

// How one turn spent its time, from its first message to the last thing the agent did. Tool time is the union of its
// timed calls; a tool waiting on the human is idle, counted as human wait, and cut out of the requests too, because a
// message can stay open while it waits. Tools that wait on machines are tool time: the agent chose to block on them.
// Idle is whatever is left of the turn.
export const measureTurn = (messages: readonly ITurnMessage[], tools: readonly ITurnTool[]): ITurnTime => {
  const first = messages[0]
  if (first === undefined) {
    throw new Error('A turn has at least one message')
  }
  const startedAt = first.createdAt
  const timed = tools.flatMap((tool) =>
    tool.startedAt === null
      ? []
      : [{ interval: [tool.startedAt, tool.endedAt ?? tool.startedAt] as const, family: tool.family }]
  )
  const endedAt = turnEnd(messages, tools)
  const within = (isHumanWait: boolean): TInterval[] =>
    union(
      timed
        .filter(({ family }) => HUMAN_WAIT_FAMILIES.has(family) === isHumanWait)
        .map(({ interval: [start, end] }) => [Math.max(start, startedAt), Math.min(end, endedAt)] as const)
    )
  const toolTime = within(false)
  const humanWaits = within(true)
  const modelMs = lengthOf(
    modelTimeOf(
      messages,
      timed.map(({ interval }) => interval),
      startedAt,
      [...toolTime, ...humanWaits]
    )
  )
  const toolMs = lengthOf(toolTime)
  return {
    startedAt,
    endedAt,
    modelMs,
    toolMs,
    idleMs: endedAt - startedAt - modelMs - toolMs,
    humanWaitMs: lengthOf(humanWaits),
  }
}

type TTool = ITurnTool & { id: string }

const turnsOf = (store: WarehouseStore): { sessionId: string; messages: ITurnMessage[] }[] => {
  const turns: { sessionId: string; messages: ITurnMessage[] }[] = []
  for (const message of store.all<ITurnMessage & { sessionId: string }>(
    `SELECT session_id AS sessionId, id, actor, created_at AS createdAt, completed_at AS completedAt
     FROM message ORDER BY session_id, seq`
  )) {
    const current = turns.at(-1)
    if (current === undefined || current.sessionId !== message.sessionId || message.actor === 'user') {
      turns.push({ sessionId: message.sessionId, messages: [message] })
    } else {
      current.messages.push(message)
    }
  }
  return turns
}

// Every session's turns: a turn starts at each user message, and at a session's first message whoever wrote it. Each
// turn of a started session is placed under the parent turn that holds the call which started it.
const buildTurns = (store: WarehouseStore): ITurnRecord[] => {
  const toolsByMessage = new Map<string, TTool[]>()
  for (const tool of store.all<TTool & { messageId: string }>(
    'SELECT id, message_id AS messageId, family, started_at AS startedAt, ended_at AS endedAt FROM tool_call ORDER BY id'
  )) {
    toolsByMessage.set(tool.messageId, [...(toolsByMessage.get(tool.messageId) ?? []), tool])
  }
  const turns = turnsOf(store)
  let seq = 0
  const records = turns.map((turn, index) => {
    seq = index > 0 && turns[index - 1]?.sessionId === turn.sessionId ? seq + 1 : 0
    const tools = turn.messages.flatMap((message) => toolsByMessage.get(message.id) ?? [])
    const first = turn.messages[0] as ITurnMessage
    return {
      tools,
      record: {
        sessionId: turn.sessionId,
        messageId: first.id,
        seq,
        isPrompt: first.actor === 'user',
        requests: turn.messages.filter((message) => message.actor === 'assistant').length,
        toolCalls: tools.length,
        ...measureTurn(turn.messages, tools),
      },
    }
  })
  const calls = new Map<string, IPlacementCall>(
    records.flatMap(({ tools, record }) =>
      tools.map(
        (tool) => [tool.id, { turnId: record.messageId, startedAt: tool.startedAt, endedAt: tool.endedAt }] as const
      )
    )
  )
  const links = store.all<IPlacementLink>(
    `SELECT parent_session_id AS parentSessionId, parent_tool_call_id AS parentToolCallId,
       child_session_id AS childSessionId, confidence
     FROM link`
  )
  const placements = placeTurns(
    records.map(({ record }) => record),
    links,
    calls
  )
  return records.map(({ record }): ITurnRecord => {
    const placement = placements.get(record.messageId)
    return {
      ...record,
      parentTurnId: placement?.parentTurnId ?? null,
      parentToolCallId: placement?.parentToolCallId ?? null,
    }
  })
}

// The turn pass of a sync: the whole table replaced in one transaction.
export const deriveTurns = (store: WarehouseStore): void => {
  store.replaceTurns(buildTurns(store))
}
