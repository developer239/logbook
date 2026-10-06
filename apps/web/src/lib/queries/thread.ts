import { sumBy } from '../lists'
import {
  agentName,
  agentRef,
  sessionOf,
  type IAgentRef,
  type IChildTurn,
  type ISession,
  type ITurn,
  type ISessionCache,
} from './session'

export interface IThreadTurn {
  id: string
  number: number
  startedAt: number
  durationMs: number
  // Null for a turn the harness started.
  prompt: { text: string; reactions: string[] } | null
  reply: { text: string; model: string | null; at: number } | null
  harnessLines: string[]
  compactions: { at: number; summary: string }[]
  steps: number
  failed: number
  spawned: ISpawn[]
}

interface ISpawn extends IAgentRef {
  outcome: string | null
  steps: number
  failed: number
  durationMs: number
  turns: IThreadTurn[]
}

// The first line of what the harness wrote, without its markup.
const harnessLine = (text: string | null): string | null => {
  const line =
    (text ?? '')
      .replace(/<[^>]+>/gu, ' ')
      .trim()
      .split('\n')[0]
      ?.trim() ?? ''

  return line === '' ? null : line
}

const isSaid = (text: string | null): text is string => (text ?? '').trim() !== ''

const threadTurn = (cache: ISessionCache, session: ISession, turn: ITurn): IThreadTurn => {
  const first = turn.messages[0]
  const reply = turn.messages.findLast((message) => message.actor === 'assistant' && isSaid(message.text))
  // Only the human's own message opens a turn with a prompt; what the harness wrote is never one.
  const prompt = first?.actor === 'user' && isSaid(first.text) ? first.text : null

  const harnessLines = turn.messages
    .filter((message) => message.actor === 'harness')
    .map((message) => harnessLine(message.text))
    .filter((line) => line !== null)

  return {
    id: turn.id,
    number: turn.seq + 1,
    startedAt: turn.startedAt,
    durationMs: turn.endedAt - turn.startedAt,
    prompt:
      prompt === null
        ? null
        : { text: prompt, reactions: (first === undefined ? undefined : session.reactions.get(first.id)) ?? [] },
    reply:
      reply === undefined
        ? null
        : { text: reply.text ?? '', model: reply.model, at: reply.completedAt ?? reply.createdAt },
    harnessLines,
    compactions: turn.messages.flatMap((message) =>
      message.compactionSummary === null ? [] : [{ at: message.createdAt, summary: message.compactionSummary }]
    ),
    steps: turn.messages.filter((message) => message.actor === 'assistant').length + turn.tools.length,
    failed: turn.tools.filter((tool) => tool.status === 'error').length,
    spawned: spawnsOf(cache, turn.id, session.childrenOfTurn.get(turn.id) ?? []),
  }
}

// A resumed session is continued from several turns, so an agent holds only the
// turns placed under this one.
const spawnsOf = (cache: ISessionCache, underTurnId: string, children: readonly IChildTurn[]): ISpawn[] =>
  [...Map.groupBy(children, (child) => child.sessionId)].map(([sessionId, ofSession]): ISpawn => {
    const session = sessionOf(cache, sessionId)
    const turnIds = new Set(ofSession.map((child) => child.turnId))
    const placed = session.turns.filter((turn) => turnIds.has(turn.id))
    const turns = placed.map((turn) => threadTurn(cache, session, turn))

    return {
      ...agentRef(cache.harnesses, session, underTurnId),
      outcome: session.outcome,
      steps: sumBy(turns, (turn) => turn.steps),
      failed: sumBy(turns, (turn) => turn.failed),
      durationMs: Math.max(...placed.map((turn) => turn.endedAt)) - Math.min(...placed.map((turn) => turn.startedAt)),
      turns,
    }
  })

export const thread = (cache: ISessionCache, sessionId: string): { agent: string; turns: IThreadTurn[] } => {
  const session = sessionOf(cache, sessionId)
  return {
    agent: agentName(cache.harnesses, session),
    turns: session.turns.map((turn) => threadTurn(cache, session, turn)),
  }
}
