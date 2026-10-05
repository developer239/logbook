import { childIdOf, compareHarnessVersions, IMAGE_PART_TEXT, timeSpan } from '@log-book/adapter-api'
import type {
  IEventRecord,
  IImportedSession,
  IMessageRecord,
  IPartRecord,
  IToolCallRecord,
  MessageActor,
  PartKind,
} from '@log-book/warehouse'
import { toolNameOf } from './families.js'
import {
  blocksOf,
  stringOf,
  timeOf,
  toolResultText,
  usageFields,
  type IContentBlock,
  type ITranscriptLine,
} from './transcript-lines.js'

export const ADAPTER_ID = 'claude-code'

// The entrypoint Claude Code writes on every line of a `claude -p` transcript.
const PRINT_ENTRYPOINT = 'sdk-cli'
// The model Claude Code names on the assistant lines it writes itself.
const SYNTHETIC_MODEL = '<synthetic>'
// Text Claude Code writes in the user's name without marking it.
const HARNESS_PREFIXES = ['<command-name>', '<command-message>', '<local-command-', '[Request interrupted']
const LOCAL_COMMAND_ROLE = 'system/local_command'

const isHarnessText = (text: string | null): boolean => {
  const start = text?.trimStart() ?? ''
  return HARNESS_PREFIXES.some((prefix) => start.startsWith(prefix))
}

// The text a user line opens with: its string content, or its first text block.
const openingText = (content: unknown): string | null =>
  stringOf(content) ?? stringOf(blocksOf(content).find((block) => block.type === 'text')?.text)

// Builds one session's records from its transcript lines, in file order.
export class SessionBuilder {
  public readonly sessionId: string
  public readonly messages: IMessageRecord[] = []
  public readonly parts: IPartRecord[] = []
  public readonly events: IEventRecord[] = []
  // By tool call id, in the order the calls were made.
  public readonly toolCalls = new Map<string, IToolCallRecord>()
  public projectDir: string | null = null
  public isScripted = false
  public harnessVersion: string | null = null
  private aiTitle: string | null = null
  private customTitle: string | null = null
  // Claude Code writes one response as one line per content block, all with the same message id, and the response's
  // tool results can sit between them: lines merge by message id across the whole file.
  private readonly assistants = new Map<string, IMessageRecord>()

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  public readonly add = (line: ITranscriptLine): void => {
    this.addSessionFields(line)
    const at = timeOf(line)
    if (at === null) {
      return
    }
    if (line.type === 'assistant') {
      this.addAssistant(line, at)
    } else if (line.type === 'user') {
      this.addUser(line, at)
    } else if (line.type === 'system' && line.subtype === 'local_command') {
      this.addLocalCommand(line, at)
    }
  }

  public readonly build = (sourceId: string): IImportedSession => ({
    session: {
      id: this.sessionId,
      harness: ADAPTER_ID,
      sourceId,
      origin: 'interactive',
      isScripted: this.isScripted,
      projectDir: this.projectDir,
      title: this.customTitle ?? this.aiTitle,
      agent: null,
      spawnedBySessionId: null,
      spawnedByToolCallId: null,
      ...timeSpan(this.messages),
    },
    messages: this.messages,
    parts: this.parts,
    toolCalls: [...this.toolCalls.values()],
    events: this.events,
  })

  private readonly addSessionFields = (line: ITranscriptLine): void => {
    this.projectDir ??= stringOf(line.cwd)
    if (line.entrypoint === PRINT_ENTRYPOINT) {
      this.isScripted = true
    }
    this.addVersion(stringOf(line.version))
    if (line.type === 'ai-title') {
      this.aiTitle = stringOf(line.aiTitle) ?? this.aiTitle
    } else if (line.type === 'custom-title') {
      this.customTitle = stringOf(line.customTitle) ?? this.customTitle
    }
  }

  // The newest version any line records; a version that does not parse never replaces one that does.
  private readonly addVersion = (version: string | null): void => {
    if (version === null) {
      return
    }
    const comparison = this.harnessVersion === null ? 1 : compareHarnessVersions(version, this.harnessVersion)
    if (comparison !== null && comparison > 0) {
      this.harnessVersion = version
    }
  }

  private readonly addAssistant = (line: ITranscriptLine, at: number): void => {
    const message = line.message ?? {}
    if (line.isApiErrorMessage === true || message.model === SYNTHETIC_MODEL) {
      this.addSynthetic(line, at)
      return
    }
    const sourceId = stringOf(message.id) ?? stringOf(line.uuid)
    if (sourceId === null) {
      return
    }
    const record = this.assistants.get(sourceId) ?? this.newAssistant(sourceId, at, line)
    Object.assign(record, { completedAt: at, ...usageFields(message.usage) })
    for (const block of blocksOf(message.content)) {
      this.addAssistantBlock(record, block, at)
    }
  }

  private readonly addAssistantBlock = (record: IMessageRecord, block: IContentBlock, at: number): void => {
    if (block.type === 'text') {
      this.addPart(record, 'text', stringOf(block.text))
    } else if (block.type === 'thinking') {
      this.addPart(record, 'reasoning', stringOf(block.thinking))
    } else if (block.type === 'tool_use') {
      this.addToolCall(record, block, at)
    }
  }

  // A call is pending, with no end, until its result is seen.
  private readonly addToolCall = (message: IMessageRecord, block: IContentBlock, at: number): void => {
    const callId = stringOf(block.id)
    const name = stringOf(block.name)
    if (callId === null || name === null) {
      return
    }
    const id = childIdOf(this.sessionId, callId)
    const inputJson = JSON.stringify(block.input ?? {})
    this.toolCalls.set(id, {
      id,
      sessionId: this.sessionId,
      messageId: message.id,
      name,
      ...toolNameOf(name),
      inputJson,
      status: 'pending',
      childSessionId: null,
      startedAt: at,
      endedAt: null,
    })
    this.addPart(message, 'tool_call', `${name} ${inputJson}`, id)
  }

  // A result whose call is not in the file (a resumed transcript that starts mid-call) keeps its part; no call is
  // invented. A large output Claude Code saved to `tool-results/` arrives as the preview it gave the model.
  private readonly addToolResult = (message: IMessageRecord, block: IContentBlock, at: number): void => {
    const callId = stringOf(block.tool_use_id)
    if (callId === null) {
      return
    }
    const id = childIdOf(this.sessionId, callId)
    this.addResultPart(message, toolResultText(block.content), id)
    const call = this.toolCalls.get(id)
    if (call !== undefined) {
      call.status = block.is_error === true ? 'error' : 'completed'
      call.endedAt = at
    }
  }

  private readonly newAssistant = (sourceId: string, at: number, line: ITranscriptLine): IMessageRecord => {
    const record = this.newMessage(sourceId, 'assistant', 'assistant', at, line)
    record.model = stringOf(line.message?.model)
    this.assistants.set(sourceId, record)
    return record
  }

  // A reply Claude Code wrote itself, not a model response: the error it shows in place of an answer, or "No
  // response requested." when a session is resumed. The error is also an error event.
  private readonly addSynthetic = (line: ITranscriptLine, at: number): void => {
    const sourceId = stringOf(line.uuid)
    if (sourceId === null) {
      return
    }
    const text = blocksOf(line.message?.content)
      .map((block) => stringOf(block.text) ?? '')
      .join('\n')
    const record = this.newMessage(sourceId, 'harness', 'assistant', at, line)
    this.addPart(record, 'text', text)
    if (line.isApiErrorMessage === true) {
      this.events.push({
        id: childIdOf(this.sessionId, sourceId),
        sessionId: this.sessionId,
        kind: 'error',
        at,
        dataJson: JSON.stringify({ error: text }),
      })
    }
  }

  private readonly addUser = (line: ITranscriptLine, at: number): void => {
    const sourceId = stringOf(line.uuid)
    if (sourceId === null) {
      return
    }
    const content = line.message?.content
    const blocks = blocksOf(content)
    const results = blocks.filter((block) => block.type === 'tool_result')
    if (results.length > 0) {
      const record = this.newMessage(sourceId, 'tool', 'user', at, line)
      for (const block of results) {
        this.addToolResult(record, block, at)
      }
      return
    }
    const record = this.newMessage(sourceId, this.userActor(line, openingText(content)), 'user', at, line)
    const kind: PartKind = line.isCompactSummary === true ? 'compaction' : 'text'
    this.addPart(record, kind, stringOf(content))
    for (const block of blocks) {
      if (block.type === 'text') {
        this.addPart(record, kind, stringOf(block.text))
      } else if (block.type === 'image') {
        this.addPart(record, 'text', IMAGE_PART_TEXT)
      }
    }
  }

  private readonly userActor = (line: ITranscriptLine, text: string | null): MessageActor => {
    const originKind = line.origin?.kind
    const isInjected = originKind !== undefined && originKind !== 'human'
    const isHarness = line.isMeta === true || line.isCompactSummary === true || isInjected || isHarnessText(text)
    return isHarness ? 'harness' : 'user'
  }

  // Claude Code 2.1 writes some typed built-in commands and their output as system lines with a string content.
  private readonly addLocalCommand = (line: ITranscriptLine, at: number): void => {
    const sourceId = stringOf(line.uuid)
    if (sourceId !== null) {
      this.addPart(this.newMessage(sourceId, 'harness', LOCAL_COMMAND_ROLE, at, line), 'text', stringOf(line.content))
    }
  }

  // requestedAt is the createdAt of the message just before a model response, whatever its actor: Claude Code records
  // no request start of its own, and the previous message is the last input the request carried.
  private readonly newMessage = (
    sourceId: string,
    actor: MessageActor,
    sourceRole: string,
    at: number,
    line: ITranscriptLine
  ): IMessageRecord => {
    const gitBranch = stringOf(line.gitBranch)
    const record: IMessageRecord = {
      id: childIdOf(this.sessionId, sourceId),
      sessionId: this.sessionId,
      seq: this.messages.length,
      actor,
      sourceRole,
      createdAt: at,
      completedAt: null,
      requestedAt: actor === 'assistant' ? (this.messages.at(-1)?.createdAt ?? null) : null,
      model: null,
      agent: null,
      gitBranch: gitBranch === '' ? null : gitBranch,
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
  private readonly addPart = (
    message: IMessageRecord,
    kind: PartKind,
    text: string | null,
    toolCallId: string | null = null
  ): void => {
    if (text !== null && text !== '') {
      this.pushPart(message, kind, text, toolCallId)
    }
  }

  // An empty result keeps its part.
  private readonly addResultPart = (message: IMessageRecord, text: string, toolCallId: string): void => {
    this.pushPart(message, 'tool_result', text, toolCallId)
  }

  private readonly pushPart = (
    message: IMessageRecord,
    kind: PartKind,
    text: string,
    toolCallId: string | null
  ): void => {
    const idx = this.parts.filter((part) => part.messageId === message.id).length
    this.parts.push({ messageId: message.id, sessionId: this.sessionId, idx, kind, text, toolCallId })
  }
}
