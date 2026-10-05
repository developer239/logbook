import type {
  IEventRecord,
  IImportedSession,
  IMessageRecord,
  IPartRecord,
  ISessionRecord,
  IToolCallRecord,
  MessageActor,
  ToolCallStatus,
} from '@log-book/warehouse'
import { childIdOf, sessionIdOf, timeSpan, unknownEvent } from '../helpers.js'
import type { ToolFamily } from '../tool-families.js'

export const INVENTED_ID = 'test-harness'

const MCP_PREFIX = 'mcp:'

export interface IInventedToolCall {
  readonly name: string
  readonly family: ToolFamily
  readonly input: Readonly<Record<string, unknown>>
  // `completed` when left out.
  readonly status?: ToolCallStatus
  // The result's text, recorded as a `tool` message right after the call's message.
  readonly result?: string
}

export interface IInventedMessage {
  readonly actor: MessageActor
  readonly text: string
  readonly at: number
  readonly model?: string
  // Calls this assistant message made.
  readonly toolCalls?: readonly IInventedToolCall[]
}

export interface IInventedSession {
  // The session's source id; the unit's locator made id-safe when left out.
  readonly sourceId?: string
  readonly projectDir?: string | null
  readonly title?: string | null
  readonly agent?: string | null
  readonly isScripted?: boolean
  // A user prompt and an assistant reply when left out.
  readonly messages?: readonly IInventedMessage[]
  // Records the harness does not know, each kept as one `unknown` event.
  readonly unknownRecords?: readonly unknown[]
}

const DEFAULT_MESSAGES: readonly IInventedMessage[] = [
  { actor: 'user', text: 'fix the failing build', at: 1_000 },
  { actor: 'assistant', text: 'The build passes now.', at: 2_000 },
]

// What one session's records are built into.
interface IBuilt {
  messages: IMessageRecord[]
  parts: IPartRecord[]
  toolCalls: IToolCallRecord[]
}

const messageRecord = (sessionId: string, seq: number, message: IInventedMessage): IMessageRecord => ({
  id: childIdOf(sessionId, `m${String(seq)}`),
  sessionId,
  seq,
  actor: message.actor,
  sourceRole: message.actor,
  createdAt: message.at,
  completedAt: null,
  requestedAt: null,
  model: message.model ?? null,
  agent: null,
  gitBranch: null,
  tokensInput: null,
  tokensOutput: null,
  tokensReasoning: null,
  tokensCacheRead: null,
  tokensCacheWrite: null,
  reportedCost: null,
})

const textPart = (
  message: IMessageRecord,
  idx: number,
  kind: IPartRecord['kind'],
  text: string,
  toolCallId: string | null
): IPartRecord => ({
  messageId: message.id,
  sessionId: message.sessionId,
  idx,
  kind,
  text,
  toolCallId,
})

const addToolCall = (built: IBuilt, message: IMessageRecord, call: IInventedToolCall, idx: number): void => {
  const id = childIdOf(message.sessionId, `call${String(built.toolCalls.length + 1)}`)
  const server = call.family.startsWith(MCP_PREFIX) ? call.family.slice(MCP_PREFIX.length) : null
  const inputJson = JSON.stringify(call.input)
  built.toolCalls.push({
    id,
    sessionId: message.sessionId,
    messageId: message.id,
    name: call.name,
    bareName: call.name,
    server,
    family: call.family,
    inputJson,
    status: call.status ?? 'completed',
    childSessionId: null,
    startedAt: message.createdAt,
    endedAt: message.createdAt,
  })
  built.parts.push(textPart(message, idx, 'tool_call', inputJson, id))
  if (call.result !== undefined) {
    const result = messageRecord(message.sessionId, built.messages.length, {
      actor: 'tool',
      text: call.result,
      at: message.createdAt,
    })
    built.messages.push(result)
    built.parts.push(textPart(result, 0, 'tool_result', call.result, id))
  }
}

const addMessage = (built: IBuilt, sessionId: string, message: IInventedMessage): void => {
  const record = messageRecord(sessionId, built.messages.length, message)
  built.messages.push(record)
  built.parts.push(textPart(record, 0, 'text', message.text, null))
  for (const [index, call] of (message.toolCalls ?? []).entries()) {
    addToolCall(built, record, call, index + 1)
  }
}

const idSafe = (locator: string): string => locator.replaceAll(/[^A-Za-z0-9_.-]/gu, '-')

const sessionRecord = (
  sessionId: string,
  sourceId: string,
  description: IInventedSession,
  messages: readonly IMessageRecord[]
): ISessionRecord => ({
  id: sessionId,
  harness: INVENTED_ID,
  sourceId,
  origin: 'interactive',
  isScripted: description.isScripted ?? false,
  projectDir: description.projectDir ?? null,
  title: description.title ?? null,
  agent: description.agent ?? null,
  spawnedBySessionId: null,
  spawnedByToolCallId: null,
  ...timeSpan(messages),
})

// The records of one described session, with ids filled by sessionIdOf and childIdOf.
export const buildSession = (
  locator: string,
  harnessVersion: string | null,
  description: IInventedSession
): IImportedSession => {
  const sourceId = description.sourceId ?? idSafe(locator)
  const sessionId = sessionIdOf(INVENTED_ID, sourceId)
  const built: IBuilt = { messages: [], parts: [], toolCalls: [] }
  for (const message of description.messages ?? DEFAULT_MESSAGES) {
    addMessage(built, sessionId, message)
  }
  const unknownAt = built.messages[0]?.createdAt ?? 0
  const events: IEventRecord[] = (description.unknownRecords ?? []).map((raw, index) =>
    unknownEvent(sessionId, `unknown${String(index + 1)}`, unknownAt, {
      what: 'record',
      type: 'invented',
      harnessVersion,
      raw,
    })
  )
  return { session: sessionRecord(sessionId, sourceId, description, built.messages), ...built, events }
}

// Ways to break one named rule of validateImportedUnit, for a test of the engine's boundary.
export type InventedInvalidRule = 'unknown-actor' | 'empty-part-text' | 'adapter-id-in-title' | 'duplicate-seq'

const BREAKS: Readonly<Record<InventedInvalidRule, (session: IImportedSession) => IImportedSession>> = {
  'unknown-actor': (session) => ({
    ...session,
    messages: session.messages.map((message, index) =>
      index === 0 ? { ...message, actor: 'narrator' as MessageActor } : message
    ),
  }),
  'empty-part-text': (session) => ({
    ...session,
    parts: session.parts.map((part, index) => (index === 0 ? { ...part, text: '' } : part)),
  }),
  'adapter-id-in-title': (session) => ({ ...session, session: { ...session.session, title: `${INVENTED_ID} run` } }),
  'duplicate-seq': (session) => ({
    ...session,
    messages: session.messages.map((message) => ({ ...message, seq: 0 })),
  }),
}

export const breakRule = (sessions: readonly IImportedSession[], rule: InventedInvalidRule): IImportedSession[] =>
  sessions.map((session) => BREAKS[rule](session))
