import type { IEventRecord, IImportedSession, IMessageRecord, IPartRecord, IToolCallRecord } from '@log-book/warehouse'
import type { IHarnessDescriptor, IImportedUnit } from './contract.js'
import { sessionIdOf } from './helpers.js'
import { isToolFamily, mcpFamily } from './tool-families.js'

const MESSAGE_ACTORS: ReadonlySet<string> = new Set(['user', 'assistant', 'tool', 'harness'])
const PART_KINDS: ReadonlySet<string> = new Set(['text', 'reasoning', 'tool_call', 'tool_result', 'compaction'])
const TOOL_CALL_STATUSES: ReadonlySet<string> = new Set(['completed', 'error', 'pending'])
const EVENT_KINDS: ReadonlySet<string> = new Set([
  'compaction',
  'model-switched',
  'agent-switched',
  'idle',
  'error',
  'tools-offered',
  'tools-loaded',
  'skill-loaded',
  'interrupted',
  'tool-rejected',
  'unknown',
])

type TReport = (record: string, problem: string) => void

interface IUnitIds {
  sessions: Set<string>
  messages: Set<string>
  toolCalls: Set<string>
  events: Set<string>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isTime = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isTimeOrNull = (value: unknown): boolean => value === null || isTime(value)

// `<parent>/<non-empty source id>`
const isChildOf = (id: string, parentId: string): boolean =>
  id.startsWith(`${parentId}/`) && id.length > parentId.length + 1

// `<adapter id>:<non-empty source id>`
const isSessionIdShape = (id: string, adapterId: string): boolean =>
  id.startsWith(`${adapterId}:`) && id.length > adapterId.length + 1

// `<adapter id>:<source id>/<source id>`, both source ids non-empty.
const isChildIdShape = (id: string, adapterId: string): boolean => {
  if (!isSessionIdShape(id, adapterId)) {
    return false
  }
  const rest = id.slice(adapterId.length + 1)
  const slash = rest.indexOf('/')
  return slash > 0 && slash < rest.length - 1
}

const parseJson = (text: string): { isValid: boolean; value: unknown } => {
  try {
    return { isValid: true, value: JSON.parse(text) as unknown }
  } catch {
    return { isValid: false, value: null }
  }
}

type TDataShape = (data: Record<string, unknown>) => boolean

// The data shape of the five event kinds that have one; any other kind only needs one JSON document.
const EVENT_DATA_SHAPES: Readonly<Record<string, TDataShape>> = {
  'tools-offered': (data) =>
    ['added', 'removed', 'surfaced'].every((key) => isStringArray(data[key])) &&
    ['pendingServers', 'needsAuthServers'].every((key) => data[key] === null || isStringArray(data[key])) &&
    (data.failedServers === null ||
      (Array.isArray(data.failedServers) &&
        data.failedServers.every(
          (server) => isRecord(server) && typeof server.name === 'string' && typeof server.error === 'string'
        ))),
  'tools-loaded': (data) =>
    Array.isArray(data.tools) &&
    data.tools.every((tool) => isRecord(tool) && typeof tool.name === 'string' && typeof tool.chars === 'number'),
  'skill-loaded': (data) =>
    typeof data.name === 'string' &&
    typeof data.chars === 'number' &&
    (data.toolCallId === null || typeof data.toolCallId === 'string'),
  'interrupted': (data) => typeof data.messageId === 'string',
  'tool-rejected': (data) => typeof data.toolCallId === 'string',
}

const isEventDataValid = (kind: string, dataJson: string): boolean => {
  const { isValid, value } = parseJson(dataJson)
  const shape = EVENT_DATA_SHAPES[kind]
  return isValid && (shape === undefined || (isRecord(value) && shape(value)))
}

// What the checks of one session share.
interface ISessionScope {
  report: TReport
  adapterId: string
  sessionId: string
  messages: Map<string, IMessageRecord>
  seqs: Set<number>
  toolCallIds: Set<string>
}

const reportChild = (scope: ISessionScope, record: string, id: string, sessionId: string): void => {
  if (!isChildOf(id, scope.sessionId)) {
    scope.report(record, 'id is not a child id of its session')
  }
  if (sessionId !== scope.sessionId) {
    scope.report(record, 'sessionId names another session')
  }
}

const claimId = (report: TReport, ids: Set<string>, record: string, id: string): void => {
  if (ids.has(id)) {
    report(record, 'id is not unique in the unit')
  }
  ids.add(id)
}

const validateSessionRecord = (scope: ISessionScope, { session }: IImportedSession): void => {
  const { report, adapterId } = scope
  const record = `session ${session.id}`
  if (session.id !== sessionIdOf(adapterId, session.sourceId) || session.harness !== adapterId) {
    report(record, `id or harness does not match the adapter id ${adapterId} and the source id`)
  }
  if (session.spawnedBySessionId !== null && !isSessionIdShape(session.spawnedBySessionId, adapterId)) {
    report(record, 'spawnedBySessionId does not have the session id shape')
  }
  if (session.spawnedByToolCallId !== null && !isChildIdShape(session.spawnedByToolCallId, adapterId)) {
    report(record, 'spawnedByToolCallId does not have the tool call id shape')
  }
  if (!isTimeOrNull(session.startedAt) || !isTimeOrNull(session.endedAt)) {
    report(record, 'a time is not epoch milliseconds or null')
  }
  if (session.origin !== 'interactive') {
    report(record, 'origin is not interactive')
  }
  // The source's own id, never text a user writes; holding the adapter id, it was prefixed twice. Every other field
  // carries the harness's data, where a user may name either agent, so it is not held to this.
  if (session.sourceId.includes(adapterId)) {
    report(record, 'sourceId contains the adapter id')
  }
}

const validateMessage = (scope: ISessionScope, message: IMessageRecord): void => {
  const { report } = scope
  const record = `message ${message.id}`
  reportChild(scope, record, message.id, message.sessionId)
  if (!isTime(message.createdAt) || !isTimeOrNull(message.completedAt) || !isTimeOrNull(message.requestedAt)) {
    report(record, 'a time is not epoch milliseconds or null, or createdAt is null')
  }
  if (!MESSAGE_ACTORS.has(message.actor)) {
    report(record, `actor ${message.actor} is not a known actor`)
  }
  if (scope.seqs.has(message.seq)) {
    report(record, `seq ${String(message.seq)} is not unique in its session`)
  }
  scope.seqs.add(message.seq)
  if (message.requestedAt !== null && message.actor !== 'assistant') {
    report(record, `requestedAt set on a ${message.actor} message`)
  }
}

// The family is a tool family, and an mcp family names the call server.
const validateToolCallFamily = (scope: ISessionScope, record: string, call: IToolCallRecord): void => {
  if (!isToolFamily(call.family)) {
    scope.report(record, `family ${call.family} is not a tool family`)
    return
  }
  if (call.family.startsWith('mcp:') && (call.server === null || call.family !== mcpFamily(call.server))) {
    scope.report(record, `family ${call.family} does not match the server ${String(call.server)}`)
  }
}

// A shell call input is {} (a call the model never finished) or carries a string command.
const validateShellInput = (scope: ISessionScope, record: string, call: IToolCallRecord): void => {
  const { isValid, value } = parseJson(call.inputJson)
  const isUnfinished = isRecord(value) && Object.keys(value).length === 0
  if (!isValid || !isRecord(value) || (!isUnfinished && typeof value.command !== 'string')) {
    scope.report(record, 'a shell call input is neither {} nor an object with a string command')
  }
}

const validateToolCall = (scope: ISessionScope, call: IToolCallRecord): void => {
  const { report, adapterId } = scope
  const record = `tool call ${call.id}`
  reportChild(scope, record, call.id, call.sessionId)
  if (scope.messages.get(call.messageId)?.actor !== 'assistant') {
    report(record, 'messageId does not name an assistant message of its session')
  }
  if (call.childSessionId !== null && !isSessionIdShape(call.childSessionId, adapterId)) {
    report(record, 'childSessionId does not have the session id shape')
  }
  if (!isTimeOrNull(call.startedAt) || !isTimeOrNull(call.endedAt)) {
    report(record, 'a time is not epoch milliseconds or null')
  }
  if (!TOOL_CALL_STATUSES.has(call.status)) {
    report(record, `status ${call.status} is not a known status`)
  }
  validateToolCallFamily(scope, record, call)
  if (call.family === 'shell') {
    validateShellInput(scope, record, call)
  }
}

// A tool_call part names a call of its session; a tool_result part only has its id shape, because a resumed
// transcript can start after the call.
const validatePartToolCall = (scope: ISessionScope, record: string, part: IPartRecord): void => {
  if (part.kind === 'tool_call' && (part.toolCallId === null || !scope.toolCallIds.has(part.toolCallId))) {
    scope.report(record, 'toolCallId does not name a tool call of its session')
  }
  if (part.kind === 'tool_result' && (part.toolCallId === null || !isChildOf(part.toolCallId, scope.sessionId))) {
    scope.report(record, 'toolCallId is not a child id of its session')
  }
}

const validatePart = (scope: ISessionScope, part: IPartRecord): void => {
  const { report, sessionId } = scope
  const record = `part ${part.messageId}#${String(part.idx)}`
  if (part.sessionId !== sessionId || !scope.messages.has(part.messageId)) {
    report(record, 'messageId or sessionId does not name a message of its session')
  }
  if (!PART_KINDS.has(part.kind)) {
    report(record, `kind ${part.kind} is not a known part kind`)
  }
  validatePartToolCall(scope, record, part)
  if (part.text === '' && part.kind !== 'tool_result') {
    report(record, 'text is empty')
  }
}

const validateEvent = (scope: ISessionScope, event: IEventRecord): void => {
  const { report } = scope
  const record = `event ${event.id}`
  reportChild(scope, record, event.id, event.sessionId)
  if (!isTime(event.at)) {
    report(record, 'at is not epoch milliseconds')
  }
  if (!EVENT_KINDS.has(event.kind)) {
    report(record, `kind ${event.kind} is not a known event kind`)
  }
  if (!isEventDataValid(event.kind, event.dataJson)) {
    report(record, `dataJson is not a JSON document of the ${event.kind} shape`)
  }
}

const validateSession = (report: TReport, adapterId: string, imported: IImportedSession, ids: IUnitIds): void => {
  const scope: ISessionScope = {
    report,
    adapterId,
    sessionId: imported.session.id,
    messages: new Map(),
    seqs: new Set(),
    toolCallIds: new Set(),
  }
  claimId(report, ids.sessions, `session ${imported.session.id}`, imported.session.id)
  validateSessionRecord(scope, imported)
  for (const message of imported.messages) {
    claimId(report, ids.messages, `message ${message.id}`, message.id)
    scope.messages.set(message.id, message)
    validateMessage(scope, message)
  }
  for (const call of imported.toolCalls) {
    claimId(report, ids.toolCalls, `tool call ${call.id}`, call.id)
    scope.toolCallIds.add(call.id)
    validateToolCall(scope, call)
  }
  for (const part of imported.parts) {
    validatePart(scope, part)
  }
  for (const event of imported.events) {
    claimId(report, ids.events, `event ${event.id}`, event.id)
    validateEvent(scope, event)
  }
}

// Every rule an imported unit breaks, one message per broken rule and record naming the record; empty for a valid
// unit. Linear in the unit's records: lookups by id, no nested scans.
export const validateImportedUnit = (descriptor: IHarnessDescriptor, unit: IImportedUnit): string[] => {
  const problems: string[] = []
  const report: TReport = (record, problem) => {
    problems.push(`${record}: ${problem}`)
  }
  const ids: IUnitIds = { sessions: new Set(), messages: new Set(), toolCalls: new Set(), events: new Set() }
  for (const imported of unit.sessions) {
    validateSession(report, descriptor.id, imported, ids)
  }
  return problems
}
