import { childIdOf, IMAGE_PART_TEXT, unknownEvent, type UnknownRecordDescription } from '@log-book/adapter-api'
import type {
  IEventRecord,
  IMessageRecord,
  IPartRecord,
  IToolCallRecord,
  MessageActor,
  PartKind,
  SessionEventKind,
} from '@log-book/warehouse'

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
      this.addUnknown(row, row.time_created, {
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
      this.addUnknown(row, at, { what: 'row', type: row.type, harnessVersion: this.harnessVersion, raw: row })
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
    for (const part of recordsOf(data.content)) {
      this.addContentPart(message, part)
    }
    if (data.error !== undefined && data.error !== null) {
      this.addEvent(row, 'error', at, { error: errorText(data.error) })
    }
  }

  private readonly addContentPart = (message: IMessageRecord, part: Record<string, unknown>): void => {
    if (part.type === 'text') {
      this.addPart(message, 'text', stringOf(part.text))
    } else if (part.type === 'reasoning') {
      this.addPart(message, 'reasoning', stringOf(part.text))
    }
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

  // An empty or missing text adds no part.
  private readonly addPart = (message: IMessageRecord, kind: PartKind, text: string | null): void => {
    if (text === null || text === '') {
      return
    }
    const idx = this.parts.filter((part) => part.messageId === message.id).length
    this.parts.push({ messageId: message.id, sessionId: this.sessionId, idx, kind, text, toolCallId: null })
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

  private readonly addUnknown = (row: IMessageRow, at: number, description: UnknownRecordDescription): void => {
    this.events.push(unknownEvent(this.sessionId, row.id, at, description))
  }
}
