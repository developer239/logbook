import { tokensOf } from '../context'
import { byPressure, harnessAgent } from '../labels'
import { countBy } from '../lists'
import { failureLabel, modelLabel, purposeLabel, REACTIONS, tokensRead } from '../sql'
import { all, get } from '../warehouse'

export const agentName = (session: { agent: string | null; harness: string }): string =>
  session.agent ?? harnessAgent(session.harness)

export const mainModel = (sessionId: string): string =>
  `(SELECT m.model FROM message m WHERE m.session_id = ${sessionId} AND m.actor = 'assistant' AND m.model IS NOT NULL
     GROUP BY m.model ORDER BY COUNT(*) DESC LIMIT 1)`

export interface IMessageRow {
  id: string
  seq: number
  actor: string
  createdAt: number
  completedAt: number | null
  model: string | null
  text: string | null
  reasoning: string | null
  compactionSummary: string | null
  tokensRead: number | null
  tokensWritten: number | null
}

export interface IToolRow {
  id: string
  messageId: string
  name: string
  family: string
  status: string
  inputJson: string
  startedAt: number | null
  endedAt: number | null
  output: string | null
  purpose: string | null
  label: string | null
}

interface ITurnRow {
  id: string
  seq: number
  firstSeq: number
  startedAt: number
  endedAt: number
  modelMs: number
  toolMs: number
  idleMs: number
}

export interface ITurn extends ITurnRow {
  messages: IMessageRow[]
  tools: IToolRow[]
}

export interface IChildTurn {
  sessionId: string
  turnId: string
  // A turn or tool call of this session.
  under: string
}

export interface ISession {
  id: string
  harness: string
  agent: string | null
  model: string | null
  outcome: string | null
  turns: ITurn[]
  turnById: Map<string, ITurn>
  messages: IMessageRow[]
  messageById: Map<string, IMessageRow>
  tools: IToolRow[]
  toolsByMessage: Map<string, IToolRow[]>
  callsByName: Map<string, number>
  // By the tool's full name, Claude Code only; the latest size where a tool was recorded more than once.
  definitionTokens: Map<string, number>
  // By the prompt's message id, the most pressing first.
  reactions: Map<string, string[]>
  childrenOfTurn: Map<string, IChildTurn[]>
  childrenOfCall: Map<string, IChildTurn[]>
}

export interface IAgentRef {
  sessionId: string
  underTurnId: string
  agent: string
  harness: string
  model: string | null
}

export const agentRef = (session: ISession, underTurnId: string): IAgentRef => ({
  sessionId: session.id,
  underTurnId,
  agent: agentName(session),
  harness: session.harness,
  model: session.model,
})

// A page reads a session several times (its thread, a spawned agent's block,
// the selected turn); the cache lives for one request.
export type SessionCache = Map<string, ISession>

export const sessionCache = (): SessionCache => new Map()

export const turnOf = (session: ISession, turnId: string): ITurn => {
  const turn = session.turnById.get(turnId)

  if (turn === undefined) {
    throw new Error(`Turn ${turnId} is not in session ${session.id}`)
  }

  return turn
}

export const messageOf = (session: ISession, messageId: string): IMessageRow => {
  const message = session.messageById.get(messageId)

  if (message === undefined) {
    throw new Error(`Message ${messageId} is not in session ${session.id}`)
  }

  return message
}

// Messages are in order, so one pass hands each to its turn; one before the
// first turn belongs to none.
export const turnsOf = (
  rows: readonly ITurnRow[],
  messages: readonly IMessageRow[],
  tools: readonly IToolRow[]
): ITurn[] => {
  const turns = rows.map((row): ITurn => ({ ...row, messages: [], tools: [] }))
  const turnOfMessage = new Map<string, ITurn>()
  let at = -1

  for (const message of messages) {
    while ((turns[at + 1]?.firstSeq ?? Number.POSITIVE_INFINITY) <= message.seq) {
      at += 1
    }

    const turn = turns[at]

    if (turn !== undefined) {
      turn.messages.push(message)
      turnOfMessage.set(message.id, turn)
    }
  }

  for (const tool of tools) {
    turnOfMessage.get(tool.messageId)?.tools.push(tool)
  }

  return turns
}

export const sessionOf = (cache: SessionCache, sessionId: string): ISession => {
  const cached = cache.get(sessionId)
  if (cached !== undefined) {
    return cached
  }

  const head = get<Pick<ISession, 'harness' | 'agent' | 'model' | 'outcome'>>(
    `SELECT s.harness, s.agent, ${mainModel('s.id')} AS model, ${modelLabel('session', 's.id', 'outcome')} AS outcome
     FROM session s WHERE s.id = ?`,
    sessionId
  )
  if (head === undefined) {
    throw new Error(`No session ${sessionId}`)
  }

  const messages = all<IMessageRow>(
    `SELECT m.id, m.seq, m.actor, m.created_at AS createdAt, m.completed_at AS completedAt, m.model,
       (SELECT group_concat(p.text, char(10) || char(10)) FROM part p
         WHERE p.message_id = m.id AND p.kind = 'text') AS text,
       (SELECT group_concat(p.text, char(10) || char(10)) FROM part p
         WHERE p.message_id = m.id AND p.kind = 'reasoning') AS reasoning,
       (SELECT group_concat(p.text, char(10) || char(10)) FROM part p
         WHERE p.message_id = m.id AND p.kind = 'compaction') AS compactionSummary,
       CASE WHEN m.tokens_input IS NULL THEN NULL ELSE ${tokensRead('m')} END AS tokensRead,
       m.tokens_output AS tokensWritten
     FROM message m WHERE m.session_id = ? ORDER BY m.seq`,
    sessionId
  )

  const tools = all<IToolRow>(
    `SELECT tc.id, tc.message_id AS messageId, tc.name, tc.family, tc.status, tc.input_json AS inputJson,
       tc.started_at AS startedAt, tc.ended_at AS endedAt,
       (SELECT p.text FROM part p WHERE p.tool_call_id = tc.id AND p.kind = 'tool_result' LIMIT 1) AS output,
       ${purposeLabel('tc')} AS purpose, ${failureLabel('tc')} AS label
     FROM tool_call tc WHERE tc.session_id = ?`,
    sessionId
  )

  const turns = turnsOf(
    all<ITurnRow>(
      `SELECT t.message_id AS id, t.seq, m.seq AS firstSeq, t.started_at AS startedAt, t.ended_at AS endedAt,
         t.model_ms AS modelMs, t.tool_ms AS toolMs, t.idle_ms AS idleMs
       FROM turn t JOIN message m ON m.id = t.message_id WHERE t.session_id = ? ORDER BY t.seq`,
      sessionId
    ),
    messages,
    tools
  )

  const session: ISession = {
    id: sessionId,
    ...head,
    turns,
    turnById: new Map(turns.map((turn) => [turn.id, turn])),
    messages,
    messageById: new Map(messages.map((message) => [message.id, message])),
    tools,
    toolsByMessage: Map.groupBy(tools, (tool) => tool.messageId),
    callsByName: countBy(tools, (tool) => tool.name),
    definitionTokens: new Map(
      all<{ name: string; chars: number }>(
        `SELECT json_extract(t.value, '$.name') AS name, json_extract(t.value, '$.chars') AS chars
         FROM event e, json_each(e.data_json, '$.tools') t WHERE e.session_id = ? AND e.kind = 'tools-loaded'
         ORDER BY e.at, e.id`,
        sessionId
      ).map((row) => [row.name, tokensOf(row.chars)])
    ),
    reactions: new Map(
      [
        ...Map.groupBy(
          all<{ id: string; reaction: string }>(
            `SELECT r.message_id AS id, r.reaction FROM ${REACTIONS} r WHERE r.session_id = ? ORDER BY r.reaction_id`,
            sessionId
          ),
          (row) => row.id
        ),
      ].map(([id, rows]) => [id, byPressure(rows.map((row) => row.reaction))])
    ),
    childrenOfTurn: Map.groupBy(
      all<IChildTurn>(
        `SELECT c.session_id AS sessionId, c.message_id AS turnId, c.parent_turn_id AS under
         FROM turn c JOIN turn p ON p.message_id = c.parent_turn_id WHERE p.session_id = ? ORDER BY c.started_at`,
        sessionId
      ),
      (child) => child.under
    ),
    childrenOfCall: Map.groupBy(
      all<IChildTurn>(
        `SELECT c.session_id AS sessionId, c.message_id AS turnId, c.parent_tool_call_id AS under
         FROM turn c JOIN tool_call tc ON tc.id = c.parent_tool_call_id WHERE tc.session_id = ? ORDER BY c.started_at`,
        sessionId
      ),
      (child) => child.under
    ),
  }

  cache.set(sessionId, session)

  return session
}
