import { sumBy } from '../lists'
import { HARNESS_PREFIXES } from '../sql'
import {
  agentName,
  agentRef,
  sessionOf,
  type IAgentRef,
  type IChildTurn,
  type ISession,
  type ITurn,
  type SessionCache,
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

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')

const NOT_A_PROMPT = new RegExp(`^\\s*(?:${HARNESS_PREFIXES.map(escapeRegExp).join('|')})`, 'u')
const COMMAND_NAME = /<command-name>\/?([^<]+)<\/command-name>/u
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/u

const harnessLine = (text: string | null): string | null => {
  const line =
    (text ?? '')
      .replace(/<[^>]+>/gu, ' ')
      .trim()
      .split('\n')[0]
      ?.trim() ?? ''

  return line === '' ? null : line
}

type Opening = { kind: 'prompt'; text: string } | { kind: 'harness'; line: string | null }

export const promptOf = (text: string): Opening => {
  if (!NOT_A_PROMPT.test(text)) {
    return { kind: 'prompt', text }
  }

  const command = COMMAND_NAME.exec(text)?.[1]
  if (command === undefined) {
    return { kind: 'harness', line: harnessLine(text) }
  }

  const args = COMMAND_ARGS.exec(text)?.[1]?.trim() ?? ''

  return { kind: 'prompt', text: `\`/${command}${args === '' ? '' : ` ${args}`}\`` }
}

const isSaid = (text: string | null): text is string => (text ?? '').trim() !== ''

const threadTurn = (cache: SessionCache, session: ISession, turn: ITurn): IThreadTurn => {
  const first = turn.messages[0]
  const reply = turn.messages.findLast((message) => message.actor === 'assistant' && isSaid(message.text))
  const opening = first?.actor === 'user' && isSaid(first.text) ? promptOf(first.text) : null

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
      opening?.kind === 'prompt'
        ? { text: opening.text, reactions: (first === undefined ? undefined : session.reactions.get(first.id)) ?? [] }
        : null,
    reply:
      reply === undefined
        ? null
        : { text: reply.text ?? '', model: reply.model, at: reply.completedAt ?? reply.createdAt },
    harnessLines: opening?.kind === 'harness' && opening.line !== null ? [opening.line, ...harnessLines] : harnessLines,
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
const spawnsOf = (cache: SessionCache, underTurnId: string, children: readonly IChildTurn[]): ISpawn[] =>
  [...Map.groupBy(children, (child) => child.sessionId)].map(([sessionId, ofSession]): ISpawn => {
    const session = sessionOf(cache, sessionId)
    const turnIds = new Set(ofSession.map((child) => child.turnId))
    const placed = session.turns.filter((turn) => turnIds.has(turn.id))
    const turns = placed.map((turn) => threadTurn(cache, session, turn))

    return {
      ...agentRef(session, underTurnId),
      outcome: session.outcome,
      steps: sumBy(turns, (turn) => turn.steps),
      failed: sumBy(turns, (turn) => turn.failed),
      durationMs: Math.max(...placed.map((turn) => turn.endedAt)) - Math.min(...placed.map((turn) => turn.startedAt)),
      turns,
    }
  })

export const thread = (cache: SessionCache, sessionId: string): { agent: string; turns: IThreadTurn[] } => {
  const session = sessionOf(cache, sessionId)
  return { agent: agentName(session), turns: session.turns.map((turn) => threadTurn(cache, session, turn)) }
}
