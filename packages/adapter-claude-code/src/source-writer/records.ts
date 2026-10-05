import { childIdOf, timeSpan } from '@log-book/adapter-api'
import type {
  IEventRecord,
  IImportedSession,
  IMessageRecord,
  IPartRecord,
  IToolCallRecord,
  MessageActor,
  PartKind,
  SessionEventKind,
} from '@log-book/warehouse'
import { ADAPTER_ID } from '../session-builder.js'

export interface ISpawn {
  sessionId: string
  toolCallId: string
  agent: string
}

interface ISessionFields {
  sourceId: string
  projectDir: string
  title: string | null
  isScripted: boolean
  spawnedBy: ISpawn | null
}

// The records the adapter imports from one transcript, built by its rules as the writer writes each line, never by
// reading the lines back.
export class ExpectedSession {
  public readonly sessionId: string
  private readonly messages: IMessageRecord[] = []
  private readonly parts: IPartRecord[] = []
  private readonly toolCalls = new Map<string, IToolCallRecord>()
  private readonly events: IEventRecord[] = []
  private readonly gitBranch: string | null

  constructor(sessionId: string, gitBranch: string | null) {
    this.sessionId = sessionId
    this.gitBranch = gitBranch === '' ? null : gitBranch
  }

  public readonly idOf = (sourceId: string): string => childIdOf(this.sessionId, sourceId)

  public readonly hasMessage = (sourceId: string): boolean =>
    this.messages.some((message) => message.id === this.idOf(sourceId))

  // requestedAt is the createdAt of the message just before a model response, whatever its actor.
  public readonly message = (sourceId: string, actor: MessageActor, sourceRole: string, at: number): IMessageRecord => {
    const record: IMessageRecord = {
      id: this.idOf(sourceId),
      sessionId: this.sessionId,
      seq: this.messages.length,
      actor,
      sourceRole,
      createdAt: at,
      completedAt: null,
      requestedAt: actor === 'assistant' ? (this.messages.at(-1)?.createdAt ?? null) : null,
      model: null,
      agent: null,
      gitBranch: this.gitBranch,
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

  public readonly find = (sourceId: string): IMessageRecord | undefined =>
    this.messages.find((message) => message.id === this.idOf(sourceId))

  // A part with an empty text is left out, except a tool result's.
  public readonly part = (
    message: IMessageRecord,
    kind: PartKind,
    text: string,
    toolCallId: string | null = null
  ): void => {
    if (text === '' && kind !== 'tool_result') {
      return
    }
    const idx = this.parts.filter((part) => part.messageId === message.id).length
    this.parts.push({ messageId: message.id, sessionId: this.sessionId, idx, kind, text, toolCallId })
  }

  public readonly toolCall = (record: IToolCallRecord): void => {
    this.toolCalls.set(record.id, record)
  }

  public readonly callOf = (id: string): IToolCallRecord | undefined => this.toolCalls.get(id)

  public readonly event = (sourceId: string, kind: SessionEventKind, at: number, data: unknown): string => {
    const id = this.idOf(sourceId)
    this.events.push({ id, sessionId: this.sessionId, kind, at, dataJson: JSON.stringify(data) })
    return id
  }

  public readonly build = (fields: ISessionFields): IImportedSession => ({
    session: {
      id: this.sessionId,
      harness: ADAPTER_ID,
      sourceId: fields.sourceId,
      origin: 'interactive',
      isScripted: fields.isScripted,
      projectDir: fields.projectDir,
      title: fields.title,
      agent: fields.spawnedBy?.agent ?? null,
      spawnedBySessionId: fields.spawnedBy?.sessionId ?? null,
      spawnedByToolCallId: fields.spawnedBy?.toolCallId ?? null,
      ...timeSpan(this.messages),
    },
    messages: this.messages,
    parts: this.parts,
    toolCalls: [...this.toolCalls.values()],
    events: this.events,
  })
}
