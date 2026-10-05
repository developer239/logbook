import { childIdOf, compareHarnessVersions, IMAGE_PART_TEXT, timeSpan } from '@log-book/adapter-api'
import type {
  IEventRecord,
  IImportedSession,
  IMessageRecord,
  IPartRecord,
  MessageActor,
  PartKind,
} from '@log-book/warehouse'
import { blocksOf, numberOf, stringOf, timeOf, type ITranscriptLine, type IUsage } from './transcript-lines.js'

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

const usageFields = (usage: IUsage | undefined): Partial<IMessageRecord> => ({
  tokensInput: numberOf(usage?.input_tokens),
  tokensOutput: numberOf(usage?.output_tokens),
  tokensReasoning: numberOf(usage?.output_tokens_details?.thinking_tokens),
  tokensCacheRead: numberOf(usage?.cache_read_input_tokens),
  tokensCacheWrite: numberOf(usage?.cache_creation_input_tokens),
})

// The text a user line opens with: its string content, or its first text block.
const openingText = (content: unknown): string | null =>
  stringOf(content) ?? stringOf(blocksOf(content).find((block) => block.type === 'text')?.text)

// Builds one session's records from its transcript lines, in file order.
export class SessionBuilder {
  public readonly sessionId: string
  public readonly messages: IMessageRecord[] = []
  public readonly parts: IPartRecord[] = []
  public readonly events: IEventRecord[] = []
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
    toolCalls: [],
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
      if (block.type === 'text') {
        this.addPart(record, 'text', stringOf(block.text))
      } else if (block.type === 'thinking') {
        this.addPart(record, 'reasoning', stringOf(block.thinking))
      }
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
    if (blocks.some((block) => block.type === 'tool_result')) {
      this.newMessage(sourceId, 'tool', 'user', at, line)
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
  private readonly addPart = (message: IMessageRecord, kind: PartKind, text: string | null): void => {
    if (text === null || text === '') {
      return
    }
    const idx = this.parts.filter((part) => part.messageId === message.id).length
    this.parts.push({ messageId: message.id, sessionId: this.sessionId, idx, kind, text, toolCallId: null })
  }
}
