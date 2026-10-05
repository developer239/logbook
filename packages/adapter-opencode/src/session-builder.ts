import {
  childIdOf,
  IMAGE_PART_TEXT,
  sessionIdOf,
  unknownEvent,
  type UnknownRecordDescription,
} from '@log-book/adapter-api'
import type {
  IEventRecord,
  IMessageRecord,
  IPartRecord,
  IToolCallRecord,
  MessageActor,
  PartKind,
  SessionEventKind,
  ToolCallStatus,
} from '@log-book/warehouse'
import { toolNameOf } from './families.js'

export const ADAPTER_ID = 'opencode'

// One session_message row, as read.
export interface IMessageRow {
  id: string
  type: string
  seq: number
  time_created: number
  time_updated: number
  data: string
}

interface IMessageData {
  text?: unknown
  files?: unknown
  time?: { created?: unknown; completed?: unknown }
  agent?: unknown
  model?: unknown
  content?: unknown
  tokens?: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } }
  cost?: unknown
  error?: unknown
  summary?: unknown
  reason?: unknown
  status?: unknown
  outcome?: unknown
  previous?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringOf = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const numberOf = (value: unknown): number | null => (typeof value === 'number' ? value : null)

const recordsOf = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => isRecord(item)) : []

// `<type>: <message>` when the error has both as strings, `<message>` when only the message, the string itself, else
// its JSON.
const errorText = (error: unknown): string => {
  if (typeof error === 'string') {
    return error
  }
  if (isRecord(error) && typeof error.message === 'string') {
    return typeof error.type === 'string' ? `${error.type}: ${error.message}` : error.message
  }
  return JSON.stringify(error)
}

// `<providerID>/<id>`, or `<id>` without a provider.
const modelName = (model: unknown): string | null => {
  if (!isRecord(model) || typeof model.id !== 'string') {
    return null
  }
  return typeof model.providerID === 'string' ? `${model.providerID}/${model.id}` : model.id
}

const tokenFields = (tokens: IMessageData['tokens']): Partial<IMessageRecord> => ({
  tokensInput: numberOf(tokens?.input),
  tokensOutput: numberOf(tokens?.output),
  tokensReasoning: numberOf(tokens?.reasoning),
  tokensCacheRead: numberOf(tokens?.cache?.read),
  tokensCacheWrite: numberOf(tokens?.cache?.write),
})

interface IToolState {
  status?: unknown
  input?: unknown
  content?: unknown
  error?: unknown
  metadata?: { exit?: unknown; sessionId?: unknown }
}

const CHILD_SESSION_PREFIX = 'ses_'

// `error` for a failed call, or a completed shell call that exited non-zero, as Claude Code records it; `completed`;
// otherwise still `pending`.
const toolStatus = (state: IToolState): ToolCallStatus => {
  const exit = numberOf(state.metadata?.exit)
  if (state.status === 'error' || (state.status === 'completed' && exit !== null && exit !== 0)) {
    return 'error'
  }
  return state.status === 'completed' ? 'completed' : 'pending'
}

// The text items of a call's content, joined with newlines.
const contentText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : recordsOf(content)
        .flatMap((item) => (item.type === 'text' && typeof item.text === 'string' ? [item.text] : []))
        .join('\n')

// The session a 1.x `task` call started, when it names one.
const childSessionOf = (state: IToolState): string | null => {
  const child = stringOf(state.metadata?.sessionId)
  return child?.startsWith(CHILD_SESSION_PREFIX) === true ? sessionIdOf(ADAPTER_ID, child) : null
}

const resultText = (status: ToolCallStatus, state: IToolState): string =>
  status === 'error' && state.error !== undefined ? errorText(state.error) : contentText(state.content)

const parseData = (text: string): IMessageData | null => {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

// An attached file as the text of its part: `(image)` for an image, else its name.
const filePartText = (file: Record<string, unknown>): string => {
  if (stringOf(file.mime)?.startsWith('image/') === true) {
    return IMAGE_PART_TEXT
  }
  const name = stringOf(file.name)
  return name === null ? '(file)' : `(file: ${name})`
}

// Builds one session's records from its message rows, in seq order.
export class SessionBuilder {
  public readonly sessionId: string
  public readonly messages: IMessageRecord[] = []
  public readonly parts: IPartRecord[] = []
  public readonly toolCalls: IToolCallRecord[] = []
  public readonly events: IEventRecord[] = []
  private readonly harnessVersion: string | null
  // The 1.x `message` table's completion times: OpenCode 2 rewrote some migrated messages' times to when it touched
  // the row, and left the 1.x record intact.
  private readonly originalCompletions: ReadonlyMap<string, number>

  constructor(sessionId: string, harnessVersion: string | null, originalCompletions: ReadonlyMap<string, number>) {
    this.sessionId = sessionId
    this.harnessVersion = harnessVersion
    this.originalCompletions = originalCompletions
  }

  // The first text part of the first user message.
  public readonly firstUserText = (): string | null => {
    const first = this.messages.find((message) => message.actor === 'user')
    return this.parts.find((part) => part.messageId === first?.id && part.kind === 'text')?.text ?? null
  }

  public readonly add = (row: IMessageRow): void => {
    const data = parseData(row.data)
    if (data === null) {
      this.addUnknown(row.id, row.time_created, {
        what: 'row',
        type: row.type,
        harnessVersion: this.harnessVersion,
        raw: row.data,
      })
      return
    }
    const at = numberOf(data.time?.created) ?? row.time_created
    const handler = this.handlers[row.type]
    if (handler === undefined) {
      this.addUnknown(row.id, at, { what: 'row', type: row.type, harnessVersion: this.harnessVersion, raw: row })
      return
    }
    handler(row, at, data)
  }

  private readonly handlers: Readonly<Record<string, (row: IMessageRow, at: number, data: IMessageData) => void>> = {
    'user': (row, at, data) => {
      const message = this.newMessage(row, 'user', at)
      this.addPart(message, 'text', stringOf(data.text))
      for (const file of recordsOf(data.files)) {
        this.addPart(message, 'text', filePartText(file))
      }
    },
    'system': (row, at, data) => {
      this.addPart(this.newMessage(row, 'harness', at), 'text', stringOf(data.text))
    },
    'synthetic': (row, at, data) => {
      this.addPart(this.newMessage(row, 'harness', at), 'text', stringOf(data.text))
    },
    'assistant': (row, at, data) => {
      this.addAssistant(row, at, data)
    },
    'compaction': (row, at, data) => {
      this.addPart(this.newMessage(row, 'harness', at), 'compaction', stringOf(data.summary))
      this.addEvent(row, 'compaction', at, { reason: data.reason ?? null, status: data.status ?? null })
    },
    'agent-switched': (row, at, data) => {
      this.addEvent(row, 'agent-switched', at, { agent: data.agent ?? null })
    },
    'model-switched': (row, at, data) => {
      this.addEvent(row, 'model-switched', at, { model: data.model ?? null, previous: data.previous ?? null })
    },
    'idle': (row, at, data) => {
      this.addEvent(row, 'idle', at, { outcome: data.outcome ?? null })
    },
  }

  // An OpenCode assistant message is created when its request starts and stays open while its tools run, so its
  // request starts at its creation. An error can end a response midway: the message keeps the parts it holds.
  private readonly addAssistant = (row: IMessageRow, at: number, data: IMessageData): void => {
    const message = this.newMessage(row, 'assistant', at)
    Object.assign(message, {
      requestedAt: at,
      completedAt: this.originalCompletions.get(row.id) ?? numberOf(data.time?.completed),
      model: modelName(data.model),
      agent: stringOf(data.agent),
      reportedCost: numberOf(data.cost),
      ...tokenFields(data.tokens),
    })
    for (const [index, part] of recordsOf(data.content).entries()) {
      this.addContentPart(row, message, part, index)
    }
    if (data.error !== undefined && data.error !== null) {
      this.addEvent(row, 'error', at, { error: errorText(data.error) })
    }
  }

  // Text and reasoning parts, tool calls, and any other part type as an unknown event.
  private readonly addContentPart = (
    row: IMessageRow,
    message: IMessageRecord,
    part: Record<string, unknown>,
    index: number
  ): void => {
    if (part.type === 'text') {
      this.addPart(message, 'text', stringOf(part.text))
    } else if (part.type === 'reasoning') {
      this.addPart(message, 'reasoning', stringOf(part.text))
    } else if (part.type === 'tool' && typeof part.id === 'string' && typeof part.name === 'string') {
      this.addToolCall(message, part.id, part.name, part)
    } else {
      this.addUnknown(`${row.id}:part-${String(index)}`, message.createdAt, {
        what: 'part',
        type: stringOf(part.type),
        harnessVersion: this.harnessVersion,
        raw: part,
      })
    }
  }

  // Before `ran` the model was still writing the input, so a call is timed from it, else from its creation.
  private readonly addToolCall = (
    message: IMessageRecord,
    callId: string,
    name: string,
    part: Record<string, unknown>
  ): void => {
    const state: IToolState = isRecord(part.state) ? part.state : {}
    const time = isRecord(part.time) ? part.time : {}
    const id = childIdOf(this.sessionId, callId)
    const inputJson = JSON.stringify(state.input ?? {})
    const status = toolStatus(state)
    const call: IToolCallRecord = {
      id,
      sessionId: this.sessionId,
      messageId: message.id,
      name,
      ...toolNameOf(name),
      inputJson,
      status,
      childSessionId: childSessionOf(state),
      startedAt: numberOf(time.ran) ?? numberOf(time.created),
      endedAt: numberOf(time.completed),
    }
    this.toolCalls.push(call)
    this.addPart(message, 'tool_call', `${name} ${inputJson}`, id)
    if (status === 'pending') {
      return
    }
    const result = resultText(status, state)
    this.addPart(message, 'tool_result', result, id)
    if (call.family === 'skill' && status === 'completed') {
      this.addSkillLoaded(callId, call, state, result, call.endedAt ?? message.createdAt)
    }
  }

  // A completed skill call loaded the skill named by its input.
  private readonly addSkillLoaded = (
    callId: string,
    call: IToolCallRecord,
    state: IToolState,
    result: string,
    at: number
  ): void => {
    const input = isRecord(state.input) ? state.input : {}
    this.events.push({
      id: childIdOf(this.sessionId, `${callId}:skill`),
      sessionId: this.sessionId,
      kind: 'skill-loaded',
      at,
      dataJson: JSON.stringify({
        name: stringOf(input.name) ?? stringOf(input.id),
        chars: result.length,
        toolCallId: call.id,
      }),
    })
  }

  private readonly newMessage = (row: IMessageRow, actor: MessageActor, at: number): IMessageRecord => {
    const record: IMessageRecord = {
      id: childIdOf(this.sessionId, row.id),
      sessionId: this.sessionId,
      seq: row.seq,
      actor,
      sourceRole: row.type,
      createdAt: at,
      completedAt: null,
      requestedAt: null,
      model: null,
      agent: null,
      gitBranch: null,
      tokensInput: null,
      tokensOutput: null,
      tokensReasoning: null,
      tokensCacheRead: null,
      tokensCacheWrite: null,
      reportedCost: null,
    }
    this.messages.push(record)
    return record
  }

  // An empty or missing text adds no part, except a call's result, which is the call's even when empty.
  private readonly addPart = (
    message: IMessageRecord,
    kind: PartKind,
    text: string | null,
    toolCallId: string | null = null
  ): void => {
    if (text === null || (text === '' && kind !== 'tool_result')) {
      return
    }
    const idx = this.parts.filter((part) => part.messageId === message.id).length
    this.parts.push({ messageId: message.id, sessionId: this.sessionId, idx, kind, text, toolCallId })
  }

  private readonly addEvent = (row: IMessageRow, kind: SessionEventKind, at: number, data: unknown): void => {
    this.events.push({
      id: childIdOf(this.sessionId, row.id),
      sessionId: this.sessionId,
      kind,
      at,
      dataJson: JSON.stringify(data),
    })
  }

  private readonly addUnknown = (sourceId: string, at: number, description: UnknownRecordDescription): void => {
    this.events.push(unknownEvent(this.sessionId, sourceId, at, description))
  }
}
