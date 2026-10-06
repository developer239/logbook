import { contextSnapshots, type IContextSnapshot } from '../context'
import { ParamError } from '../errors'
import { causeOf } from '../labels'
import { MINUTE } from '../time'
import { failuresWithCause, isSlow, usualTime } from './calls'
import { contextEvents } from './context-events'
import { turnPath } from './conversation'
import {
  agentName,
  agentRef,
  messageOf,
  sessionOf,
  turnOf,
  type IAgentRef,
  type IMessageRow,
  type ISession,
  type ITurn,
  type ISessionCache,
} from './session'

// A request whose first output came this long after the session was ready did
// not wait on the model all that time.
const IDLE_GAP_MS = 10 * MINUTE

interface IStepBase {
  id: string
  level: number
  startAt: number
  // Null for a tool call its source left untimed.
  durationMs: number | null
}

interface IModelStep extends IStepBase {
  kind: 'model'
  model: string | null
  tokensRead: number | null
  tokensWritten: number | null
  text: string | null
  reasoning: string | null
}

interface IStartedAgent extends IAgentRef {
  steps: Step[]
  failed: number
}

interface IToolStep extends IStepBase {
  kind: 'tool'
  name: string
  family: string
  isFailed: boolean
  // Null when it did not fail, or failed with a real result.
  cause: string | null
  purpose: string | null
  inputJson: string
  output: string | null
  started: IStartedAgent | null
}

export type Step = IModelStep | IToolStep

export const everyStep = (steps: readonly Step[]): Step[] =>
  steps.flatMap((step) => [
    step,
    ...(step.kind === 'tool' && step.started !== null ? everyStep(step.started.steps) : []),
  ])

export interface ITurnDetail {
  id: string
  sessionId: string
  agent: string
  number: number
  startedAt: number
  durationMs: number
  // A started agent can carry the last step past the turn's own end.
  spanMs: number
  modelMs: number
  toolMs: number
  idleMs: number
  steps: Step[]
  nestedSteps: number
  // Null for a turn with no request that recorded its tokens.
  context: { first: IContextSnapshot; last: IContextSnapshot; isSame: boolean } | null
}

const modelStep = (message: IMessageRow, readyAt: number, level: number): IModelStep => {
  const end = message.completedAt ?? message.createdAt
  // The request started when the session was ready, unless the gap was long
  // enough that the session sat idle.
  const start = message.createdAt - readyAt >= IDLE_GAP_MS ? message.createdAt : readyAt

  return {
    kind: 'model',
    id: message.id,
    level,
    startAt: start,
    durationMs: end - start,
    model: message.model,
    tokensRead: message.tokensRead,
    tokensWritten: message.tokensWritten,
    text: message.text,
    reasoning: message.reasoning,
  }
}

const turnSteps = (cache: ISessionCache, session: ISession, turn: ITurn, level: number): Step[] => {
  // The session is ready for a request at the end of the last step before its
  // first output (a Claude transcript stamps a request only as it streams).
  const ends = [
    ...turn.messages.map((message) =>
      message.actor === 'assistant' ? (message.completedAt ?? message.createdAt) : message.createdAt
    ),
    ...turn.tools.flatMap((tool) => (tool.endedAt === null ? [] : [tool.endedAt])),
  ]

  const models = turn.messages
    .filter((message) => message.actor === 'assistant')
    .map((message) =>
      modelStep(message, Math.max(turn.startedAt, ...ends.filter((at) => at <= message.createdAt)), level)
    )

  const calls = turn.tools.map((tool): IToolStep => {
    const childTurns = session.childrenOfCall.get(tool.id) ?? []
    const children = childTurns.flatMap((child) => {
      const childSession = sessionOf(cache, child.sessionId)
      return turnSteps(cache, childSession, turnOf(childSession, child.turnId), level + 1)
    })

    const first = childTurns[0]
    const startedSession = first === undefined ? null : sessionOf(cache, first.sessionId)

    return {
      kind: 'tool',
      id: tool.id,
      level,
      startAt: tool.startedAt ?? messageOf(session, tool.messageId).createdAt,
      durationMs: tool.startedAt === null || tool.endedAt === null ? null : tool.endedAt - tool.startedAt,
      name: tool.bareName,
      family: tool.family,
      isFailed: tool.status === 'error',
      cause: tool.status === 'error' ? causeOf(tool.family, tool.label) : null,
      purpose: tool.purpose,
      inputJson: tool.inputJson,
      output: tool.output,
      started:
        startedSession === null
          ? null
          : {
              ...agentRef(cache.harnesses, startedSession, turn.id),
              steps: children,
              failed: everyStep(children).filter((child) => child.kind === 'tool' && child.isFailed).length,
            },
    }
  })

  return [...models, ...calls].toSorted((left, right) => left.startAt - right.startAt)
}

const turnContext = (session: ISession, turn: ITurn): ITurnDetail['context'] => {
  const requests = turn.messages.filter((message) => message.actor === 'assistant' && message.tokensRead !== null)
  const first = requests[0]
  const last = requests.at(-1)

  if (first === undefined || last === undefined) {
    return null
  }

  const snapshots = contextSnapshots(contextEvents(session), new Set([first.id, last.id]))
  const firstSnapshot = snapshots.get(first.id)
  const lastSnapshot = snapshots.get(last.id)

  if (firstSnapshot === undefined || lastSnapshot === undefined) {
    throw new Error(`Turn ${turn.id} has requests the session's context did not reach`)
  }

  return { first: firstSnapshot, last: lastSnapshot, isSame: first.id === last.id }
}

const turnDetail = (cache: ISessionCache, sessionId: string, turnId: string): ITurnDetail => {
  const session = sessionOf(cache, sessionId)
  const turn = turnOf(session, turnId)
  const steps = turnSteps(cache, session, turn, 0)
  const flat = everyStep(steps)
  const lastEnd = Math.max(turn.endedAt, ...flat.map((step) => step.startAt + (step.durationMs ?? 0)))

  return {
    id: turn.id,
    sessionId,
    agent: agentName(cache.harnesses, session),
    number: turn.seq + 1,
    startedAt: turn.startedAt,
    durationMs: turn.endedAt - turn.startedAt,
    spanMs: lastEnd - turn.startedAt,
    modelMs: turn.modelMs,
    toolMs: turn.toolMs,
    idleMs: turn.idleMs,
    steps,
    nestedSteps: flat.length - steps.length,
    context: turnContext(session, turn),
  }
}

export interface ISelectedStep {
  id: string
  usualMs: number | null
  isSlow: boolean
  sameCauseFailures: number
}

const selectedStep = (step: Step): ISelectedStep => {
  if (step.kind === 'model') {
    return { id: step.id, usualMs: null, isSlow: false, sameCauseFailures: 0 }
  }

  return {
    id: step.id,
    usualMs: step.durationMs === null ? null : usualTime(step),
    isSlow: isSlow(step, step.durationMs),
    sameCauseFailures: step.cause === null ? 0 : failuresWithCause(step.cause),
  }
}

export const shownTurn = (
  cache: ISessionCache,
  sessionId: string,
  turnId: string,
  stepId: string | null
): { turn: ITurnDetail; path: Set<string>; selected: ISelectedStep | null } => {
  const path = turnPath(turnId)
  const own = path[0]

  if (own === undefined || !path.some((turn) => turn.sessionId === sessionId)) {
    throw new ParamError(`This conversation has no turn ${turnId}`)
  }

  const turn = turnDetail(cache, own.sessionId, own.id)
  const turns = new Set(path.map((row) => row.id))

  if (stepId === null) {
    return { turn, path: turns, selected: null }
  }

  const step = everyStep(turn.steps).find((row) => row.id === stepId)

  if (step === undefined) {
    throw new ParamError(`This turn has no step ${stepId}`)
  }

  return { turn, path: turns, selected: selectedStep(step) }
}
