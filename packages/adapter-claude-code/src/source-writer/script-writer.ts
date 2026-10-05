import { join } from 'node:path'
import { IMAGE_PART_TEXT, sessionIdOf } from '@log-book/adapter-api'
import {
  SOURCE_WRITER_ERROR_CODES,
  type IScriptTokens,
  type ISessionScript,
  type ScriptEvent,
  type ScriptStep,
} from '@log-book/adapter-api/source-writer'
import { LogBookError } from '@log-book/core'
import type { IImportedSession } from '@log-book/warehouse'
import { toolNameOf } from '../families.js'
import { ADAPTER_ID, isHarnessText } from '../session-builder.js'
import { ExpectedSession, type ISpawn } from './records.js'
import { claudeToolCall } from './tool-inputs.js'

// The version written for a script that names none: the newest tested.
const WRITER_VERSION = '2.1.286'
const SESSION_PREFIX = 'de30da7a'
const REFUSAL =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
const INTERRUPTED = '[Request interrupted by user]'
const INTERRUPTED_FOR_TOOL = '[Request interrupted by user for tool use]'
// An invented one-pixel image.
const IMAGE_DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

type TLine = Record<string, unknown>
type TStep<TKind extends ScriptStep['kind']> = Extract<ScriptStep, { kind: TKind }>

export interface ICounters {
  session: number
  message: number
  call: number
  request: number
  agent: number
}

export interface ITranscript {
  // Relative to the home.
  path: string
  lines: TLine[]
  // The time of its last line, which the file's modification time is set to.
  lastAt: number
}

export interface IWriteContext {
  counters: ICounters
  ids: Map<string, string>
  transcripts: ITranscript[]
  expected: IImportedSession[]
}

// Where a transcript goes: a main session's own file, or a subagent's under its main session.
interface IPlace {
  // The main session's id, which every line of the unit carries.
  mainSessionId: string
  // The project directory of the main transcript, relative to the home.
  projectPath: string
  agentId: string | null
  spawnedBy: ISpawn | null
}

interface IReply {
  messageId: string
  requestId: string
  model: string
  usage: Record<string, unknown>
}

const unsupported = (key: string, reason: string): LogBookError =>
  new LogBookError(`Script ${key}: ${reason}.`, SOURCE_WRITER_ERROR_CODES.WRITER_SCRIPT_UNSUPPORTED)

const padded = (value: number, length: number): string => String(value).padStart(length, '0')

const stamp = (at: number): string => new Date(at).toISOString()

// The project's directory name under `projects`: every character other than a letter or digit becomes `-`.
export const projectSlug = (projectDir: string): string => projectDir.replaceAll(/[^A-Za-z0-9]/gu, '-')

const USAGE_KEYS: readonly (readonly [string, keyof IScriptTokens])[] = [
  ['input_tokens', 'input'],
  ['output_tokens', 'output'],
  ['cache_read_input_tokens', 'cacheRead'],
  ['cache_creation_input_tokens', 'cacheWrite'],
]

// The usage Claude Code records for the tokens a reply reports; a count the script leaves out stays out.
const usageOf = (tokens: IScriptTokens | null): Record<string, unknown> => {
  if (tokens === null) {
    return {}
  }
  const usage: Record<string, unknown> = Object.fromEntries(
    USAGE_KEYS.flatMap(([name, field]) => (tokens[field] === null ? [] : [[name, tokens[field]]]))
  )
  if (tokens.reasoning !== null) {
    usage.output_tokens_details = { thinking_tokens: tokens.reasoning }
  }
  return usage
}

const tokenFields = (tokens: IScriptTokens | null): Record<string, number | null> =>
  tokens === null
    ? { tokensInput: null, tokensOutput: null, tokensReasoning: null, tokensCacheRead: null, tokensCacheWrite: null }
    : {
        tokensInput: tokens.input,
        tokensOutput: tokens.output,
        tokensReasoning: tokens.reasoning,
        tokensCacheRead: tokens.cacheRead,
        tokensCacheWrite: tokens.cacheWrite,
      }

// Writes one script as a Claude Code transcript, and the records the adapter imports from it.
export class ScriptWriter {
  private readonly context: IWriteContext
  private readonly script: ISessionScript
  private readonly place: IPlace
  private readonly sessionNumber: number
  private readonly sourceId: string
  private readonly expected: ExpectedSession
  private readonly lines: TLine[] = []
  private reply: IReply | null = null
  private lastAt = 0
  private tokens: IScriptTokens | null = null

  constructor(context: IWriteContext, script: ISessionScript, place: IPlace) {
    this.context = context
    this.script = script
    this.place = place
    context.counters.session += 1
    this.sessionNumber = context.counters.session
    this.sourceId = place.agentId === null ? place.mainSessionId : `${place.mainSessionId}/agent-${place.agentId}`
    this.expected = new ExpectedSession(sessionIdOf(ADAPTER_ID, this.sourceId), script.gitBranch)
    context.ids.set(script.key, this.expected.sessionId)
  }

  public static readonly mainSessionId = (counters: ICounters): string =>
    `${SESSION_PREFIX}-0000-4000-8000-${padded(counters.session + 1, 12)}`

  public readonly write = (): void => {
    if (this.script.steps.length === 0) {
      throw unsupported(this.script.key, 'Claude Code writes no transcript for a session without a step')
    }
    if (this.script.title !== null) {
      this.lines.push({ type: 'ai-title', aiTitle: this.script.title, sessionId: this.place.mainSessionId })
    }
    for (const step of this.script.steps) {
      this.step(step)
    }
    const file =
      this.place.agentId === null
        ? `${this.place.mainSessionId}.jsonl`
        : join(this.place.mainSessionId, 'subagents', `agent-${this.place.agentId}.jsonl`)
    this.context.transcripts.push({ path: join(this.place.projectPath, file), lines: this.lines, lastAt: this.lastAt })
    this.context.expected.push(
      this.expected.build({
        sourceId: this.sourceId,
        projectDir: this.script.projectDir,
        title: this.script.title,
        isScripted: this.script.isScripted,
        spawnedBy: this.place.spawnedBy,
      })
    )
  }

  private readonly step = (step: ScriptStep): void => {
    const writeStep = this.steps[step.kind] as (step: ScriptStep) => void
    writeStep(step)
  }

  private readonly steps: { readonly [TKind in ScriptStep['kind']]: (step: TStep<TKind>) => void } = {
    prompt: (step) => {
      this.prompt(step)
    },
    reply: (step) => {
      this.startReply(step)
    },
    call: (step) => {
      this.call(step)
    },
    spawn: (step) => {
      this.spawn(step)
    },
    skill: (step) => {
      this.skill(step)
    },
    command: (step) => {
      this.command(step)
    },
    event: (step) => {
      this.event(step)
    },
    interrupt: (step) => {
      this.interrupt(step.key, step.at, INTERRUPTED)
    },
  }

  // A line with the fields every Claude Code line carries; its uuid numbers the line within the file.
  private readonly line = (at: number, fields: TLine): string => {
    const uuid = `${SESSION_PREFIX}-${padded(this.sessionNumber, 4)}-4000-8000-${padded(this.lines.length + 1, 12)}`
    this.lines.push({
      parentUuid: null,
      isSidechain: this.place.agentId !== null,
      userType: 'external',
      cwd: this.script.projectDir,
      sessionId: this.place.mainSessionId,
      version: this.script.harnessVersion ?? WRITER_VERSION,
      gitBranch: this.script.gitBranch ?? '',
      entrypoint: this.script.isScripted ? 'sdk-cli' : 'cli',
      ...(this.place.agentId === null ? {} : { agentId: this.place.agentId }),
      uuid,
      timestamp: stamp(at),
      ...fields,
    })
    this.lastAt = at
    return uuid
  }

  private readonly userText = (at: number, content: unknown, text: string, fields: TLine = {}): string => {
    const uuid = this.line(at, { type: 'user', ...fields, message: { role: 'user', content } })
    const actor = fields.isMeta === true || fields.isCompactSummary === true || isHarnessText(text) ? 'harness' : 'user'
    const kind = fields.isCompactSummary === true ? 'compaction' : 'text'
    this.expected.part(this.expected.message(uuid, actor, 'user', at), kind, text)
    return uuid
  }

  private readonly prompt = (step: TStep<'prompt'>): void => {
    const images = Array.from({ length: step.images }, () => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: IMAGE_DATA },
    }))
    const uuid = this.line(step.at, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: step.text }, ...images] },
    })
    const record = this.expected.message(uuid, isHarnessText(step.text) ? 'harness' : 'user', 'user', step.at)
    this.expected.part(record, 'text', step.text)
    for (let image = 0; image < step.images; image += 1) {
      this.expected.part(record, 'text', IMAGE_PART_TEXT)
    }
    this.context.ids.set(step.key, record.id)
  }

  private readonly startReply = (step: TStep<'reply'>): void => {
    this.context.counters.message += 1
    this.context.counters.request += 1
    this.reply = {
      messageId: `msg_demo${String(this.context.counters.message)}`,
      requestId: `req_demo${String(this.context.counters.request)}`,
      model: step.model,
      usage: usageOf(step.tokens),
    }
    this.tokens = step.tokens
    this.context.ids.set(step.key, this.expected.idOf(this.reply.messageId))
    if (step.reasoning !== null) {
      this.assistant(step.endAt, { type: 'thinking', thinking: step.reasoning, signature: '' })
    }
    if (step.text !== null) {
      this.assistant(step.endAt, { type: 'text', text: step.text })
    }
  }

  // One line of the current reply; every line of a reply shares its message id and usage.
  private readonly assistant = (at: number, block: Record<string, unknown>): void => {
    const { reply } = this
    if (reply === null) {
      throw new Error('An assistant line needs a reply')
    }
    this.line(at, {
      type: 'assistant',
      requestId: reply.requestId,
      message: {
        id: reply.messageId,
        type: 'message',
        role: 'assistant',
        model: reply.model,
        content: [block],
        stop_reason: null,
        usage: reply.usage,
      },
    })
    const record = this.expected.find(reply.messageId) ?? this.newReplyRecord(reply, at)
    record.completedAt = at
    Object.assign(record, tokenFields(this.tokens))
    if (block.type === 'thinking') {
      this.expected.part(record, 'reasoning', String(block.thinking))
    } else if (block.type === 'text') {
      this.expected.part(record, 'text', String(block.text))
    }
  }

  private readonly newReplyRecord = (reply: IReply, at: number): ReturnType<ExpectedSession['message']> => {
    const record = this.expected.message(reply.messageId, 'assistant', 'assistant', at)
    record.model = reply.model
    return record
  }

  // A tool_use line in the current reply, its call pending until its result.
  private readonly toolUse = (key: string, name: string, input: Record<string, unknown>, at: number): string => {
    this.context.counters.call += 1
    const toolUseId = `toolu_demo${String(this.context.counters.call)}`
    this.assistant(at, { type: 'tool_use', id: toolUseId, name, input })
    const id = this.expected.idOf(toolUseId)
    const inputJson = JSON.stringify(input)
    const replyRecord = this.expected.find(this.reply?.messageId ?? '')
    this.expected.toolCall({
      id,
      sessionId: this.expected.sessionId,
      messageId: replyRecord?.id ?? '',
      name,
      ...toolNameOf(name),
      inputJson,
      status: 'pending',
      childSessionId: null,
      startedAt: at,
      endedAt: null,
    })
    if (replyRecord !== undefined) {
      this.expected.part(replyRecord, 'tool_call', `${name} ${inputJson}`, id)
    }
    this.context.ids.set(key, id)
    return toolUseId
  }

  // The result line of a call: a tool message whose part holds the result text; it ends the call.
  private readonly result = (
    toolUseId: string,
    at: number,
    text: string,
    isError: boolean,
    fields: TLine = {}
  ): void => {
    const block = { tool_use_id: toolUseId, type: 'tool_result', content: text, ...(isError ? { is_error: true } : {}) }
    const uuid = this.line(at, { type: 'user', message: { role: 'user', content: [block] }, ...fields })
    const id = this.expected.idOf(toolUseId)
    this.expected.part(this.expected.message(uuid, 'tool', 'user', at), 'tool_result', text, id)
    const call = this.expected.callOf(id)
    if (call !== undefined) {
      call.status = isError ? 'error' : 'completed'
      call.endedAt = at
    }
  }

  private readonly call = (step: TStep<'call'>): void => {
    const { name, input } = claudeToolCall(step)
    const toolUseId = this.toolUse(step.key, name, input, step.startAt)
    if (step.status === 'pending' || step.endAt === null) {
      return
    }
    if (step.status === 'rejected') {
      this.result(toolUseId, step.endAt, REFUSAL, true)
      this.expected.event(`${toolUseId}:rejected`, 'tool-rejected', step.endAt, {
        toolCallId: this.expected.idOf(toolUseId),
      })
      this.interrupt(null, step.endAt, INTERRUPTED_FOR_TOOL)
      return
    }
    this.result(toolUseId, step.endAt, step.result ?? '', step.status === 'error')
  }

  private readonly interrupt = (key: string | null, at: number, text: string): void => {
    const uuid = this.userText(at, [{ type: 'text', text }], text)
    const id = this.expected.event(`${uuid}:interrupted`, 'interrupted', at, { messageId: this.expected.idOf(uuid) })
    if (key !== null) {
      this.context.ids.set(key, id)
    }
  }

  private readonly spawn = (step: TStep<'spawn'>): void => {
    const toolUseId = this.toolUse(
      step.key,
      'Agent',
      { prompt: step.prompt, subagent_type: step.agentType },
      step.startAt
    )
    this.context.counters.agent += 1
    const agentId = `demo${String(this.context.counters.agent)}`
    const childSourceId = `${this.place.mainSessionId}/agent-${agentId}`
    const toolCallId = this.expected.idOf(toolUseId)
    new ScriptWriter(this.context, step.child, {
      mainSessionId: this.place.mainSessionId,
      projectPath: this.place.projectPath,
      agentId,
      spawnedBy: { sessionId: this.expected.sessionId, toolCallId, agent: step.agentType },
    }).write()
    const call = this.expected.callOf(toolCallId)
    if (call !== undefined) {
      call.childSessionId = sessionIdOf(ADAPTER_ID, childSourceId)
    }
    this.resultBlocks(toolUseId, step.endAt, step.result, {
      toolUseResult: { status: 'completed', agentId, prompt: step.prompt },
    })
  }

  // A result whose content is a list of text blocks, as an agent's result is.
  private readonly resultBlocks = (toolUseId: string, at: number, text: string, fields: TLine): void => {
    const uuid = this.line(at, {
      type: 'user',
      message: {
        role: 'user',
        content: [{ tool_use_id: toolUseId, type: 'tool_result', content: [{ type: 'text', text }] }],
      },
      ...fields,
    })
    const id = this.expected.idOf(toolUseId)
    this.expected.part(this.expected.message(uuid, 'tool', 'user', at), 'tool_result', text, id)
    const call = this.expected.callOf(id)
    if (call !== undefined) {
      call.status = 'completed'
      call.endedAt = at
    }
  }

  private readonly skill = (step: TStep<'skill'>): void => {
    const toolUseId = this.toolUse(step.key, 'Skill', { skill: step.name }, step.startAt)
    this.result(toolUseId, step.endAt, `Launching skill: ${step.name}`, false)
    const text = `Base directory for this skill: ${this.script.projectDir}/.claude/skills/${step.name}\n\n${step.text}`
    const uuid = this.userText(step.endAt, [{ type: 'text', text }], text, { isMeta: true, sourceToolUseID: toolUseId })
    this.expected.event(`${uuid}:skill`, 'skill-loaded', step.endAt, {
      name: step.name,
      chars: text.length,
      toolCallId: this.expected.idOf(toolUseId),
    })
  }

  private readonly command = (step: TStep<'command'>): void => {
    const text = `<command-message>${step.name}</command-message>\n<command-name>/${step.name}</command-name>\n<command-args>${step.arguments}</command-args>`
    const uuid = this.userText(step.at, text, text)
    this.context.ids.set(step.key, this.expected.idOf(uuid))
  }

  private readonly event = (step: TStep<'event'>): void => {
    const id = this.eventLines(step.key, step.at, step.event)
    this.context.ids.set(step.key, id)
  }

  private readonly eventLines = (key: string, at: number, event: ScriptEvent): string => {
    if (event.type === 'compaction') {
      return this.compaction(at, event.summary)
    }
    if (event.type === 'failed-request') {
      const uuid = this.line(at, { type: 'system', subtype: 'api_error', level: 'error', error: event.error })
      return this.expected.event(uuid, 'error', at, { error: event.error, retryAttempt: null })
    }
    if (event.type === 'tools-offered') {
      return this.toolsOffered(at, event)
    }
    if (event.type === 'tools-loaded') {
      return this.toolsLoaded(key, at, event)
    }
    throw unsupported(key, `Claude Code records no ${event.type} event`)
  }

  // A compaction boundary, then the summary Claude Code continues from.
  private readonly compaction = (at: number, summary: string): string => {
    const uuid = this.line(at, {
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      level: 'info',
      compactMetadata: null,
    })
    const id = this.expected.event(uuid, 'compaction', at, { metadata: null })
    this.userText(at, summary, summary, { isCompactSummary: true, isVisibleInTranscriptOnly: true })
    return id
  }

  private readonly toolsOffered = (at: number, event: Extract<ScriptEvent, { type: 'tools-offered' }>): string => {
    const failedServers = event.failedServers.map(({ name, error }) => ({ name, error }))
    const uuid = this.line(at, {
      type: 'attachment',
      attachment: {
        type: 'deferred_tools_delta',
        addedNames: event.added,
        removedNames: event.removed,
        failedMcpServers: failedServers,
      },
    })
    return this.expected.event(uuid, 'tools-offered', at, {
      added: [...new Set(event.added)],
      removed: [...new Set(event.removed)],
      surfaced: [],
      pendingServers: null,
      needsAuthServers: null,
      failedServers,
    })
  }

  private readonly toolsLoaded = (
    key: string,
    at: number,
    event: Extract<ScriptEvent, { type: 'tools-loaded' }>
  ): string => {
    if (event.tools.length === 0) {
      throw unsupported(key, 'Claude Code imports no tools-loaded event without a tool')
    }
    const entries = event.tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      input_schema: inputSchema,
    }))
    const uuid = this.line(at, { type: 'attachment', attachment: { type: 'deferred_tools_record', entries } })
    return this.expected.event(uuid, 'tools-loaded', at, {
      tools: entries.map((entry) => ({
        name: entry.name,
        chars: entry.name.length + entry.description.length + JSON.stringify(entry.input_schema ?? {}).length,
      })),
    })
  }
}
