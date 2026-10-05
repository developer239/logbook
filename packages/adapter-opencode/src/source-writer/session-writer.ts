import { childIdOf, IMAGE_PART_TEXT, sessionIdOf, timeSpan } from '@log-book/adapter-api'
import type { IScriptTokens, ISessionScript, ScriptEvent, ScriptStep } from '@log-book/adapter-api/source-writer'
import type {
  IEventRecord,
  IImportedSession,
  IMessageRecord,
  IToolCallRecord,
  MessageActor,
  PartKind,
  SessionEventKind,
  ToolCallStatus,
} from '@log-book/warehouse'
import { templatePrefix, withoutFrontMatter } from '../commands.js'
import { ADAPTER_ID, DECLINED } from '../session-builder.js'
import { openCodeToolCall, unsupported } from './tool-inputs.js'

const WRITER_VERSION = '2.0.21'
// What OpenCode 2.0 writes on a step it ended early: the person stopped it, or declined one of its calls.
const STEP_INTERRUPTED = 'Step interrupted'
const ABORTED = 'aborted'
const PROJECT_ID = 'prj_demo1'
const IMAGE_MIME = 'image/png'
const SHELL_OUTPUT = '!`'
const POSITIONAL = /\$(?<position>[1-9])/gu

type TStep<TKind extends ScriptStep['kind']> = Extract<ScriptStep, { kind: TKind }>
type TColumns = Record<string, string | number | null>
type TRowError = string | { type: string; message: string }

interface ICounters {
  session: number
  message: number
  part: number
}

export interface IWriteContext {
  counters: ICounters
  ids: Map<string, string>
  sessionRows: TColumns[]
  messageRows: TColumns[]
  expected: IImportedSession[]
}

interface IExpectedPart {
  kind: PartKind
  text: string
  toolCallId: string | null
}

// One session_message row and what the adapter imports from it.
interface IRow {
  id: string
  type: string
  seq: number
  at: number
  completedAt: number | null
  data: Record<string, unknown>
  error: TRowError | null
  message: IMessageRecord | null
  parts: IExpectedPart[]
  calls: IToolCallRecord[]
  events: IEventRecord[]
}

interface IParent {
  sourceId: string
  agent: string
}

// The values a script left as null stay out of the record, so they import as null.
const present = (values: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined))

// `<provider>/<id>` split at its first `/`, as OpenCode records a model.
const modelOf = (model: string): Record<string, string> => {
  const slash = model.indexOf('/')
  return slash === -1 ? { id: model } : { providerID: model.slice(0, slash), id: model.slice(slash + 1) }
}

const tokensOf = (tokens: IScriptTokens): Record<string, unknown> => {
  const cache = present({ read: tokens.cacheRead, write: tokens.cacheWrite })
  return present({
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cache: Object.keys(cache).length === 0 ? null : cache,
  })
}

const tokenFields = (tokens: IScriptTokens | null): Partial<IMessageRecord> =>
  tokens === null
    ? {}
    : {
        tokensInput: tokens.input,
        tokensOutput: tokens.output,
        tokensReasoning: tokens.reasoning,
        tokensCacheRead: tokens.cacheRead,
        tokensCacheWrite: tokens.cacheWrite,
      }

const errorTextOf = (error: TRowError): string =>
  typeof error === 'string' ? error : `${error.type}: ${error.message}`

// `opencode run` wraps a message holding a space in double quotes, escaping the quotes inside.
const quoted = (key: string, text: string): string => {
  if (!text.includes(' ')) {
    throw unsupported(key, 'opencode run writes a first prompt with no space unquoted')
  }
  return `"${text.replaceAll('"', '\\"')}"`
}

// A part's own id, from the id of the call it became.
const partIdOf = (callId: string): string => callId.slice(callId.lastIndexOf('/') + 1)

const isQuotedRunPrompt = (text: string | undefined): boolean =>
  text !== undefined && text.length > 1 && text.startsWith('"') && text.endsWith('"') && text.includes(' ')

// The prompt OpenCode sends for a command: its file's body without front matter, the arguments in place of
// `$ARGUMENTS` and each positional argument in place of `$1` to `$9`.
const commandText = (step: TStep<'command'>): string => {
  if (step.body === null) {
    throw unsupported(step.key, 'OpenCode records a command as its file body, and the script gives none')
  }
  if (templatePrefix(step.body) === null) {
    throw unsupported(step.key, 'the body is too short to be recognised as its command')
  }
  if (step.body.includes(SHELL_OUTPUT)) {
    throw unsupported(step.key, 'OpenCode would put shell output in place of the body')
  }
  const words = step.arguments.split(/\s+/u).filter((word) => word !== '')
  return withoutFrontMatter(step.body)
    .trim()
    .replaceAll('$ARGUMENTS', step.arguments)
    .replaceAll(POSITIONAL, (_match, position: string) => words[Number(position) - 1] ?? '')
}

// The state of a call's tool part, by the script's status.
const stateOf = (step: TStep<'call'>, input: Record<string, unknown>): Record<string, unknown> => {
  const states: Readonly<Record<TStep<'call'>['status'], () => Record<string, unknown>>> = {
    completed: () => ({
      status: 'completed',
      input,
      content: step.result === null ? [] : [{ type: 'text', text: step.result }],
    }),
    error: () => ({ status: 'error', input, error: step.result ?? '' }),
    pending: () => ({ status: 'running', input }),
    rejected: () => ({ status: 'error', input, error: { type: ABORTED, message: DECLINED } }),
  }
  return states[step.status]()
}

const resultOf = (step: TStep<'call'>): string | null => {
  const results: Readonly<Record<TStep<'call'>['status'], string | null>> = {
    completed: step.result ?? '',
    error: step.result ?? '',
    pending: null,
    rejected: errorTextOf({ type: ABORTED, message: DECLINED }),
  }
  return results[step.status]
}

// Writes one script as OpenCode 2.0's session_v2 and session_message rows, and builds what the adapter imports from
// them by its rules, row by row, so events come in the order the adapter reads the rows.
export class SessionWriter {
  private readonly context: IWriteContext
  private readonly script: ISessionScript
  private readonly parent: IParent | null
  private readonly sourceId: string
  private readonly sessionId: string
  private readonly rows: IRow[] = []
  // The reply the next call, spawn or skill goes in; null once OpenCode ended its step.
  private reply: IRow | null = null
  private agent: string | null

  constructor(context: IWriteContext, script: ISessionScript, parent: IParent | null) {
    this.context = context
    this.script = script
    this.parent = parent
    context.counters.session += 1
    this.sourceId = `ses_demo${String(context.counters.session)}`
    this.sessionId = sessionIdOf(ADAPTER_ID, this.sourceId)
    this.agent = parent?.agent ?? script.agent
  }

  public readonly write = (): void => {
    if (this.script.steps.length === 0) {
      throw unsupported(this.script.key, 'OpenCode records no session without a step')
    }
    this.context.ids.set(this.script.key, this.sessionId)
    for (const step of this.script.steps) {
      this.step(step)
    }
    this.finish()
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
      this.userRow(step.key, step.at, { text: commandText(step), time: { created: step.at } })
    },
    event: (step) => {
      this.scriptEvent(step.key, step.at, step.event)
    },
    interrupt: (step) => {
      const { reply } = this
      if (reply === null) {
        throw unsupported(step.key, 'OpenCode stops only a step it is still writing')
      }
      this.stop(reply, step.at)
      this.context.ids.set(step.key, childIdOf(this.sessionId, `${reply.id}:interrupted`))
    },
  }

  // In a scripted session the first prompt is written as `opencode run` sends it.
  private readonly prompt = (step: TStep<'prompt'>): void => {
    const isFirstScripted = this.script.isScripted && !this.rows.some((row) => row.type === 'user')
    const files = Array.from({ length: step.images }, (_image, index) => ({
      mime: IMAGE_MIME,
      name: `image-${String(index + 1)}.png`,
    }))
    const row = this.userRow(step.key, step.at, {
      text: isFirstScripted ? quoted(step.key, step.text) : step.text,
      ...(files.length === 0 ? {} : { files }),
      time: { created: step.at },
    })
    files.forEach(() => {
      this.part(row, 'text', IMAGE_PART_TEXT)
    })
  }

  private readonly userRow = (key: string, at: number, data: Record<string, unknown>): IRow => {
    const row = this.addRow('user', at, data)
    this.message(row, 'user')
    this.part(row, 'text', String(data.text))
    this.reply = null
    this.context.ids.set(key, childIdOf(this.sessionId, row.id))
    return row
  }

  // An OpenCode assistant message is created when its request starts and stays open while its tools run.
  private readonly startReply = (step: TStep<'reply'>): void => {
    const content: Record<string, unknown>[] = []
    const row = this.addRow('assistant', step.at, {
      time: { created: step.at },
      ...present({
        agent: this.agent,
        model: modelOf(step.model),
        tokens: step.tokens === null ? null : tokensOf(step.tokens),
        cost: step.cost,
      }),
      content,
    })
    row.completedAt = step.endAt
    Object.assign(this.message(row, 'assistant'), {
      requestedAt: step.at,
      model: step.model,
      agent: this.agent,
      reportedCost: step.cost,
      ...tokenFields(step.tokens),
    })
    for (const [type, text] of [
      ['reasoning', step.reasoning],
      ['text', step.text],
    ] as const) {
      if (text !== null) {
        content.push({ type, text })
        this.part(row, type, text)
      }
    }
    this.reply = row
    this.context.ids.set(step.key, childIdOf(this.sessionId, row.id))
  }

  private readonly openReply = (key: string): IRow => {
    if (this.reply === null) {
      throw unsupported(key, 'OpenCode ends a step at a declined call, so nothing follows in it')
    }
    return this.reply
  }

  private readonly call = (step: TStep<'call'>): void => {
    const row = this.openReply(step.key)
    const { name, input } = openCodeToolCall(step)
    const status: ToolCallStatus = step.status === 'rejected' ? 'error' : step.status
    const callId = this.toolPart(row, {
      name,
      family: step.family,
      input,
      state: stateOf(step, input),
      status,
      result: resultOf(step),
      startAt: step.startAt,
      endAt: step.endAt,
    })
    this.context.ids.set(step.key, callId)
    if (step.status === 'rejected' && step.endAt !== null) {
      this.addEvent(row, `${partIdOf(callId)}:rejected`, 'tool-rejected', step.endAt, { toolCallId: callId })
      this.stop(row, step.endAt)
    }
  }

  // A `subagent` call whose state names no child, then the child's own session, with this one as its parent.
  private readonly spawn = (step: TStep<'spawn'>): void => {
    const row = this.openReply(step.key)
    const input = { prompt: step.prompt, agent: step.agentType }
    const callId = this.toolPart(row, {
      name: 'subagent',
      family: 'subagent',
      input,
      state: { status: 'completed', input, content: [{ type: 'text', text: step.result }] },
      status: 'completed',
      result: step.result,
      startAt: step.startAt,
      endAt: step.endAt,
    })
    this.context.ids.set(step.key, callId)
    new SessionWriter(this.context, step.child, { sourceId: this.sourceId, agent: step.agentType }).write()
  }

  private readonly skill = (step: TStep<'skill'>): void => {
    const row = this.openReply(step.key)
    const input = { name: step.name }
    const callId = this.toolPart(row, {
      name: 'skill',
      family: 'skill',
      input,
      state: { status: 'completed', input, content: [{ type: 'text', text: step.text }] },
      status: 'completed',
      result: step.text,
      startAt: step.startAt,
      endAt: step.endAt,
    })
    this.context.ids.set(step.key, callId)
    this.addEvent(row, `${partIdOf(callId)}:skill`, 'skill-loaded', step.endAt, {
      name: step.name,
      chars: step.text.length,
      toolCallId: callId,
    })
  }

  // A tool part on the reply, timed from its start, and its call with the call and result parts.
  private readonly toolPart = (
    row: IRow,
    call: {
      name: string
      family: string
      input: Record<string, unknown>
      state: Record<string, unknown>
      status: ToolCallStatus
      result: string | null
      startAt: number
      endAt: number | null
    }
  ): string => {
    this.context.counters.part += 1
    const partId = `prt_demo${String(this.context.counters.part)}`
    const id = childIdOf(this.sessionId, partId)
    const inputJson = JSON.stringify(call.input)
    ;(row.data.content as Record<string, unknown>[]).push({
      type: 'tool',
      id: partId,
      name: call.name,
      state: call.state,
      time: present({ created: call.startAt, ran: call.startAt, completed: call.endAt }),
    })
    row.calls.push({
      id,
      sessionId: this.sessionId,
      messageId: row.message?.id ?? '',
      name: call.name,
      server: null,
      bareName: call.name,
      family: call.family,
      inputJson,
      status: call.status,
      childSessionId: null,
      startedAt: call.startAt,
      endedAt: call.endAt,
    })
    this.part(row, 'tool_call', `${call.name} ${inputJson}`, id)
    if (call.result !== null) {
      this.part(row, 'tool_result', call.result, id)
    }
    if (call.endAt !== null) {
      row.completedAt = Math.max(row.completedAt ?? call.endAt, call.endAt)
    }
    return id
  }

  // OpenCode ends the step: the message ends aborted at that time, and an `idle` row says the request was interrupted.
  private readonly stop = (row: IRow, at: number): void => {
    row.error = { type: ABORTED, message: STEP_INTERRUPTED }
    row.completedAt = at
    this.eventRow('idle', at, { outcome: 'interrupted' }, 'idle', { outcome: 'interrupted' })
    this.reply = null
  }

  private readonly scriptEvent = (key: string, at: number, event: ScriptEvent): void => {
    const handlers: {
      readonly [TType in ScriptEvent['type']]?: (event: Extract<ScriptEvent, { type: TType }>) => string
    } = {
      'compaction': ({ summary }) => {
        const row = this.addRow('compaction', at, { summary, time: { created: at } })
        this.message(row, 'harness')
        this.part(row, 'compaction', summary)
        return this.addEvent(row, row.id, 'compaction', at, { reason: null, status: null })
      },
      // An assistant row with the error and no parts; its error event is added with the row's others.
      'failed-request': ({ error }) => {
        const row = this.addRow('assistant', at, { time: { created: at }, error })
        Object.assign(this.message(row, 'assistant'), { requestedAt: at })
        row.error = error
        return childIdOf(this.sessionId, row.id)
      },
      'model-switch': ({ model, previous }) => {
        const data = { model: modelOf(model), previous: modelOf(previous) }
        return this.eventRow('model-switched', at, data, 'model-switched', data)
      },
      'agent-switch': ({ agent }) => {
        this.agent = agent
        return this.eventRow('agent-switched', at, { agent }, 'agent-switched', { agent })
      },
      'idle': ({ outcome }) => this.eventRow('idle', at, { outcome }, 'idle', { outcome }),
    }
    const handler = handlers[event.type] as ((event: ScriptEvent) => string) | undefined
    if (handler === undefined) {
      throw unsupported(key, `OpenCode records no ${event.type} event`)
    }
    this.context.ids.set(key, handler(event))
  }

  // A row that is only an event.
  private readonly eventRow = (
    type: string,
    at: number,
    data: Record<string, unknown>,
    kind: SessionEventKind,
    eventData: unknown
  ): string => {
    const row = this.addRow(type, at, { ...data, time: { created: at } })
    return this.addEvent(row, row.id, kind, at, eventData)
  }

  private readonly addRow = (type: string, at: number, data: Record<string, unknown>): IRow => {
    this.context.counters.message += 1
    const row: IRow = {
      id: `msg_demo${String(this.context.counters.message)}`,
      type,
      seq: this.rows.length + 1,
      at,
      completedAt: null,
      data,
      error: null,
      message: null,
      parts: [],
      calls: [],
      events: [],
    }
    this.rows.push(row)
    return row
  }

  private readonly message = (row: IRow, actor: MessageActor): IMessageRecord => {
    const record: IMessageRecord = {
      id: childIdOf(this.sessionId, row.id),
      sessionId: this.sessionId,
      seq: row.seq,
      actor,
      sourceRole: row.type,
      createdAt: row.at,
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
    row.message = record
    return record
  }

  // An empty text adds no part, except a call's result.
  private readonly part = (row: IRow, kind: PartKind, text: string, toolCallId: string | null = null): void => {
    if (text !== '' || kind === 'tool_result') {
      row.parts.push({ kind, text, toolCallId })
    }
  }

  private readonly addEvent = (
    row: IRow,
    sourceId: string,
    kind: SessionEventKind,
    at: number,
    data: unknown
  ): string => {
    const id = childIdOf(this.sessionId, sourceId)
    row.events.push({ id, sessionId: this.sessionId, kind, at, dataJson: JSON.stringify(data) })
    return id
  }

  // An assistant row's end: its completion time, then its error and, for a stopped step, its interruption, after the
  // events of its parts.
  private readonly closeRow = (row: IRow): void => {
    if (row.completedAt !== null && row.message !== null) {
      ;(row.data.time as Record<string, unknown>).completed = row.completedAt
      row.message.completedAt = row.completedAt
    }
    if (row.error === null) {
      return
    }
    row.data.error = row.error
    this.addEvent(row, row.id, 'error', row.at, { error: errorTextOf(row.error) })
    if (typeof row.error !== 'string' && row.error.type === ABORTED) {
      this.addEvent(row, `${row.id}:interrupted`, 'interrupted', row.completedAt ?? row.at, {
        messageId: childIdOf(this.sessionId, row.id),
      })
    }
  }

  // The scripted rule the adapter applies: a top-level session whose first prompt is one whole quoted string with a
  // space. A script it would import differently is refused.
  private readonly checkScripted = (): boolean => {
    const firstUser = this.rows.find((row) => row.type === 'user')
    const isScripted =
      this.parent === null && isQuotedRunPrompt(firstUser?.parts.find((part) => part.kind === 'text')?.text)
    if (isScripted !== this.script.isScripted) {
      throw unsupported(
        this.script.key,
        this.script.isScripted
          ? 'OpenCode marks only a top-level session that opencode run started as scripted'
          : 'the first prompt is a whole quoted string with a space, which imports as scripted'
      )
    }
    return isScripted
  }

  private readonly finish = (): void => {
    const isScripted = this.checkScripted()
    for (const row of this.rows) {
      this.closeRow(row)
    }
    const createdAt = this.rows[0]?.at ?? 0
    this.writeRows(createdAt)
    const messages = this.rows.flatMap((row) => (row.message === null ? [] : [row.message]))
    const span = timeSpan(messages)
    this.context.expected.push({
      session: {
        id: this.sessionId,
        harness: ADAPTER_ID,
        sourceId: this.sourceId,
        origin: 'interactive',
        isScripted,
        projectDir: this.script.projectDir,
        title: this.script.title,
        agent: this.sessionAgent(),
        spawnedBySessionId: this.parent === null ? null : sessionIdOf(ADAPTER_ID, this.parent.sourceId),
        spawnedByToolCallId: null,
        startedAt: span.startedAt ?? createdAt,
        endedAt: span.endedAt,
      },
      messages,
      parts: this.rows.flatMap((row) => {
        const messageId = row.message?.id
        return messageId === undefined
          ? []
          : row.parts.map((part, idx) => ({ messageId, sessionId: this.sessionId, idx, ...part }))
      }),
      toolCalls: this.rows.flatMap((row) => row.calls),
      events: this.rows.flatMap((row) => row.events),
    })
  }

  private readonly sessionAgent = (): string | null => this.parent?.agent ?? this.script.agent

  // The session's session_v2 row, timed from its first and last row, and its session_message rows.
  private readonly writeRows = (createdAt: number): void => {
    this.context.sessionRows.push({
      id: this.sourceId,
      project_id: PROJECT_ID,
      parent_id: this.parent?.sourceId ?? null,
      slug: `demo-${this.sourceId.slice('ses_demo'.length)}`,
      directory: this.script.projectDir,
      title: this.script.title,
      version: this.script.harnessVersion ?? WRITER_VERSION,
      agent: this.sessionAgent(),
      time_created: createdAt,
      time_updated: Math.max(...this.rows.map((row) => row.completedAt ?? row.at)),
    })
    this.context.messageRows.push(
      ...this.rows.map((row) => ({
        id: row.id,
        session_id: this.sourceId,
        type: row.type,
        seq: row.seq,
        time_created: row.at,
        time_updated: row.completedAt ?? row.at,
        data: JSON.stringify(row.data),
      }))
    )
  }
}
