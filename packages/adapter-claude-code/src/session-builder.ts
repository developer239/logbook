import {
  childIdOf,
  compareHarnessVersions,
  IMAGE_PART_TEXT,
  timeSpan,
  unknownEvent,
  type UnknownRecordDescription,
} from '@log-book/adapter-api'
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
import { IGNORED_KINDS, lineKind, skillLoaded, TITLE_KINDS, toolsLoaded, toolsOffered } from './line-events.js'
import {
  blocksOf,
  stringOf,
  timeOf,
  toolResultText,
  usageFields,
  type IContentBlock,
  type ITranscriptEntry,
  type ITranscriptLine,
} from './transcript-lines.js'

export const ADAPTER_ID = 'claude-code'

// The entrypoint Claude Code writes on every line of a `claude -p` transcript, and on an interactive one.
const PRINT_ENTRYPOINT = 'sdk-cli'
const KNOWN_ENTRYPOINTS: ReadonlySet<string> = new Set(['cli', PRINT_ENTRYPOINT])
// The model Claude Code names on the assistant lines it writes itself.
const SYNTHETIC_MODEL = '<synthetic>'
// Text Claude Code writes in the user's name without marking it.
const HARNESS_PREFIXES = ['<command-name>', '<command-message>', '<local-command-', '[Request interrupted']
const LOCAL_COMMAND_ROLE = 'system/local_command'

const isHarnessText = (text: string | null): boolean => {
  const start = text?.trimStart() ?? ''
  return HARNESS_PREFIXES.some((prefix) => start.startsWith(prefix))
}

// A line's source id: its uuid, else its 1-based line number, which is stable for an append-only file.
const sourceIdOf = (line: ITranscriptLine, number: number): string => stringOf(line.uuid) ?? `line-${String(number)}`

// The text a user line opens with: its string content, or its first text block.
const openingText = (content: unknown): string | null =>
  stringOf(content) ?? stringOf(blocksOf(content).find((block) => block.type === 'text')?.text)

// Maps one line of a known kind; false when the line misses a field its record requires.
type TLineHandler = (line: ITranscriptLine, at: number, number: number) => boolean

// An event whose time may still be unknown: an unknown record with no time of its own and no timed line before it
// takes the session's first recorded time.
interface IPendingEvent {
  event: Omit<IEventRecord, 'at'>
  at: number | null
}

// Builds one session's records from its transcript lines, in file order. Every kind of line is mapped, ignored on
// purpose (IGNORED_KINDS) or kept whole as an `unknown` event.
export class SessionBuilder {
  public readonly sessionId: string
  public readonly messages: IMessageRecord[] = []
  public readonly parts: IPartRecord[] = []
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
  private readonly events: IPendingEvent[] = []
  private hasEntrypointEvent = false
  // The time of the latest and of the first line that records one.
  private lastTime: number | null = null
  private firstTime: number | null = null
  private readonly handlers: Readonly<Record<string, TLineHandler>> = {
    'user': (line, at, number) => this.addUser(line, at, number),
    'assistant': (line, at, number) => this.addAssistant(line, at, number),
    'system:local_command': (line, at) => this.addLocalCommand(line, at),
    'system:compact_boundary': (line, at, number) =>
      this.addEvent(line, number, 'compaction', { metadata: line.compactMetadata ?? null }, at),
    'system:api_error': (line, at, number) =>
      this.addEvent(
        line,
        number,
        'error',
        { error: line.error ?? null, retryAttempt: typeof line.retryAttempt === 'number' ? line.retryAttempt : null },
        at
      ),
    'attachment:deferred_tools_delta': (line, at, number) => {
      const data = toolsOffered(line.attachment)
      return data !== undefined && this.addEvent(line, number, 'tools-offered', data, at)
    },
    // With no named entry it says nothing was loaded, and is left out on purpose.
    'attachment:deferred_tools_record': (line, at, number) => {
      const data = toolsLoaded(line.attachment)
      return data === undefined || this.addEvent(line, number, 'tools-loaded', data, at)
    },
  }

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  public readonly add = ({ number, line, raw }: ITranscriptEntry): void => {
    if (line === null) {
      this.addUnknown(
        `line-${String(number)}`,
        { what: 'record', type: null, harnessVersion: null, raw },
        this.lastTime
      )
      return
    }
    const own = timeOf(line)
    this.addSessionFields(line, own)
    this.addLine(line, number, own)
    if (own !== null) {
      this.lastTime = own
      this.firstTime ??= own
    }
  }

  private readonly addLine = (line: ITranscriptLine, number: number, own: number | null): void => {
    const kind = lineKind(line)
    if (TITLE_KINDS.has(kind) || IGNORED_KINDS.has(kind)) {
      return
    }
    const handler = this.handlers[kind]
    if (handler === undefined || own === null || !handler(line, own, number)) {
      const description = { what: 'record', type: kind, harnessVersion: stringOf(line.version), raw: line } as const
      this.addUnknown(sourceIdOf(line, number), description, own ?? this.lastTime)
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
    events: this.resolvedEvents(),
  })

  // A session that records no time at all cannot hold an event, so its unknown records are not stored.
  private readonly resolvedEvents = (): IEventRecord[] =>
    this.events.flatMap(({ event, at }) => {
      const time = at ?? this.firstTime
      return time === null ? [] : [{ ...event, at: time }]
    })

  private readonly addEvent = (
    line: ITranscriptLine,
    number: number,
    kind: IEventRecord['kind'],
    data: unknown,
    at: number
  ): boolean => {
    this.events.push({
      event: {
        id: childIdOf(this.sessionId, sourceIdOf(line, number)),
        sessionId: this.sessionId,
        kind,
        dataJson: JSON.stringify(data),
      },
      at,
    })
    return true
  }

  private readonly addUnknown = (sourceId: string, description: UnknownRecordDescription, at: number | null): void => {
    const { id, sessionId, kind, dataJson } = unknownEvent(this.sessionId, sourceId, 0, description)
    this.events.push({ event: { id, sessionId, kind, dataJson }, at })
  }

  private readonly addSessionFields = (line: ITranscriptLine, own: number | null): void => {
    this.projectDir ??= stringOf(line.cwd)
    this.addEntrypoint(line.entrypoint, own)
    this.addVersion(stringOf(line.version))
    if (line.type === 'ai-title') {
      this.aiTitle = stringOf(line.aiTitle) ?? this.aiTitle
    } else if (line.type === 'custom-title') {
      this.customTitle = stringOf(line.customTitle) ?? this.customTitle
    }
  }

  // `sdk-cli` makes the session scripted; an entrypoint other than it and `cli` shows up once per session as a field
  // event instead of being guessed.
  private readonly addEntrypoint = (entrypoint: unknown, own: number | null): void => {
    if (entrypoint === PRINT_ENTRYPOINT) {
      this.isScripted = true
    }
    if (entrypoint === undefined || (typeof entrypoint === 'string' && KNOWN_ENTRYPOINTS.has(entrypoint))) {
      return
    }
    if (!this.hasEntrypointEvent) {
      this.hasEntrypointEvent = true
      this.addUnknown(
        'field-entrypoint',
        { what: 'field', field: 'entrypoint', value: entrypoint },
        own ?? this.lastTime
      )
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

  private readonly addAssistant = (line: ITranscriptLine, at: number, number: number): boolean => {
    const message = line.message ?? {}
    if (line.isApiErrorMessage === true || message.model === SYNTHETIC_MODEL) {
      return this.addSynthetic(line, at, number)
    }
    const sourceId = stringOf(message.id) ?? stringOf(line.uuid)
    if (sourceId === null) {
      return false
    }
    const record = this.assistants.get(sourceId) ?? this.newAssistant(sourceId, at, line)
    Object.assign(record, { completedAt: at, ...usageFields(message.usage) })
    for (const [index, block] of blocksOf(message.content).entries()) {
      this.addAssistantBlock(record, block, at, () => this.addUnknownBlock(line, number, index, block, at))
    }
    return true
  }

  private readonly addAssistantBlock = (
    record: IMessageRecord,
    block: IContentBlock,
    at: number,
    keepUnknown: () => void
  ): void => {
    if (block.type === 'text') {
      this.addPart(record, 'text', stringOf(block.text))
    } else if (block.type === 'thinking') {
      this.addPart(record, 'reasoning', stringOf(block.thinking))
    } else if (block.type === 'tool_use') {
      this.addToolCall(record, block, at)
    } else {
      keepUnknown()
    }
  }

  // A content block of a type the message mapping does not name.
  private readonly addUnknownBlock = (
    line: ITranscriptLine,
    number: number,
    index: number,
    block: IContentBlock,
    at: number
  ): void => {
    const description = {
      what: 'block',
      type: String(block.type),
      harnessVersion: stringOf(line.version),
      raw: block,
    } as const
    this.addUnknown(`${sourceIdOf(line, number)}:block-${String(index)}`, description, at)
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
  private readonly addSynthetic = (line: ITranscriptLine, at: number, number: number): boolean => {
    const sourceId = stringOf(line.uuid)
    if (sourceId === null) {
      return false
    }
    const text = blocksOf(line.message?.content)
      .map((block) => stringOf(block.text) ?? '')
      .join('\n')
    const record = this.newMessage(sourceId, 'harness', 'assistant', at, line)
    this.addPart(record, 'text', text)
    return line.isApiErrorMessage !== true || this.addEvent(line, number, 'error', { error: text }, at)
  }

  private readonly addUser = (line: ITranscriptLine, at: number, number: number): boolean => {
    const sourceId = stringOf(line.uuid)
    if (sourceId === null) {
      return false
    }
    const content = line.message?.content
    const blocks = blocksOf(content)
    if (blocks.some((block) => block.type === 'tool_result')) {
      const record = this.newMessage(sourceId, 'tool', 'user', at, line)
      for (const [index, block] of blocks.entries()) {
        if (block.type === 'tool_result') {
          this.addToolResult(record, block, at)
        } else {
          this.addUnknownBlock(line, number, index, block, at)
        }
      }
      return true
    }
    const record = this.newMessage(sourceId, this.userActor(line, openingText(content)), 'user', at, line)
    const kind: PartKind = line.isCompactSummary === true ? 'compaction' : 'text'
    this.addPart(record, kind, stringOf(content))
    for (const [index, block] of blocks.entries()) {
      this.addUserBlock(record, kind, block, () => this.addUnknownBlock(line, number, index, block, at))
    }
    this.addSkillLoaded(line, sourceId, at)
    return true
  }

  private readonly addUserBlock = (
    record: IMessageRecord,
    kind: PartKind,
    block: IContentBlock,
    keepUnknown: () => void
  ): void => {
    if (block.type === 'text') {
      this.addPart(record, kind, stringOf(block.text))
    } else if (block.type === 'image') {
      this.addPart(record, 'text', IMAGE_PART_TEXT)
    } else {
      keepUnknown()
    }
  }

  // A meta line that loads a skill is also a `skill-loaded` event, tied to the Skill call that loaded it when the line
  // names one; it stays a harness message.
  private readonly addSkillLoaded = (line: ITranscriptLine, sourceId: string, at: number): void => {
    const skill = skillLoaded(line)
    if (skill === null) {
      return
    }
    const callId = stringOf(line.sourceToolUseID)
    this.events.push({
      event: {
        id: childIdOf(this.sessionId, `${sourceId}:skill`),
        sessionId: this.sessionId,
        kind: 'skill-loaded',
        dataJson: JSON.stringify({ ...skill, toolCallId: callId === null ? null : childIdOf(this.sessionId, callId) }),
      },
      at,
    })
  }

  private readonly userActor = (line: ITranscriptLine, text: string | null): MessageActor => {
    const originKind = line.origin?.kind
    const isInjected = originKind !== undefined && originKind !== 'human'
    const isHarness = line.isMeta === true || line.isCompactSummary === true || isInjected || isHarnessText(text)
    return isHarness ? 'harness' : 'user'
  }

  // Claude Code 2.1 writes some typed built-in commands and their output as system lines with a string content.
  private readonly addLocalCommand = (line: ITranscriptLine, at: number): boolean => {
    const sourceId = stringOf(line.uuid)
    if (sourceId === null) {
      return false
    }
    this.addPart(this.newMessage(sourceId, 'harness', LOCAL_COMMAND_ROLE, at, line), 'text', stringOf(line.content))
    return true
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
