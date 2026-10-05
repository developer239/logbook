import type { ICommandFile, IScriptTokens, ISessionScript, ScriptStep } from '@log-book/adapter-api/source-writer'
import type { PromptAct } from '@log-book/engine'
import type { ISubagentTask, ITurnShape, UseName } from '../corpus/shapes.js'
import type { IToolEntry } from '../corpus/tools.js'
import { createStream, type IRandomStream } from '../random.js'
import type { IPlan, IPlanCorpus, IPlannedSession, IPlannedTurn, IWriterDeclaration, IWriterScripts } from './types.js'

type TCommandStep = Extract<ScriptStep, { kind: 'command' }>

interface IScriptInputs {
  corpus: IPlanCorpus
  writers: readonly IWriterDeclaration[]
}

// A step of a turn the agent's reply leads to: a call, a skill load or a started session. `at` is null for a use the
// layout times, and the start of one that runs at its own time.
interface IUse {
  at: number | null
  durationMs: number
  write: (startAt: number) => ScriptStep[]
}

// What a turn opens with and how its last reply reads.
interface ITurnPlan {
  shape: ITurnShape
  prompt: string
  closing: string
}

const SECOND_MS = 1000
// The pause between a built-in command and the prompt typed after it.
const TYPING_MS = 3 * SECOND_MS
// The shortest reply: a turn with no room for its uses fails rather than squeezing them.
const MIN_REPLY_MS = SECOND_MS
// The `claude -p` call exits a moment after the session it started ends.
const EXIT_MS = SECOND_MS
const MICRO = 1_000_000
const SLOT = /\{(?<name>[a-z]+)\}/gu

// A template with each `{slot}` filled; a slot without a value is a corpus error.
const fill = (template: string, slots: Readonly<Record<string, string>>): string =>
  template.replaceAll(SLOT, (match: string, name: string) => {
    const value = slots[name]
    if (value === undefined) {
      throw new Error(`No value for the slot ${match} in: ${template}`)
    }
    return value
  })

const tokensOf = (stream: IRandomStream, hasReasoning: boolean): IScriptTokens => ({
  input: stream.integer(800, 6000),
  output: stream.integer(60, 900),
  reasoning: hasReasoning ? stream.integer(40, 600) : null,
  cacheRead: stream.integer(4000, 60_000),
  cacheWrite: stream.integer(0, 3000),
})

const firstOf = (steps: readonly ScriptStep[], kind: 'prompt' | 'reply', fromEnd: boolean): string => {
  const ordered = fromEnd ? steps.toReversed() : steps
  const step = ordered.find((candidate) => candidate.kind === kind)
  const text = step?.kind === 'prompt' || step?.kind === 'reply' ? step.text : null
  if (text === null) {
    throw new Error(`A script has no ${kind} with text`)
  }
  return text
}

// The scripts of one writer: its top-level sessions in plan order, each started session inside the spawn step that
// starts it, with only the steps and fields the writer declares.
class WriterScripter {
  public readonly corpus: IPlanCorpus
  public readonly seed: number
  public readonly acts: Record<string, PromptAct> = {}
  private readonly plan: IPlan
  private readonly declaration: IWriterDeclaration
  private readonly writer: number
  private readonly models = new Map<string, string>()
  private readonly built = new Map<string, ISessionScript>()

  constructor(plan: IPlan, inputs: IScriptInputs, writer: number) {
    const declaration = inputs.writers[writer]
    if (declaration === undefined || declaration.models.length === 0) {
      throw new Error(`Writer ${String(writer)} declares no model`)
    }
    this.plan = plan
    this.corpus = inputs.corpus
    this.seed = plan.seed
    this.declaration = declaration
    this.writer = writer
    // Round the writer's models in plan order, so every model replies whatever the seed.
    this.ownSessions().forEach((session, index) => {
      this.models.set(session.key, declaration.models[index % declaration.models.length] ?? '')
    })
  }

  public readonly scripts = (): IWriterScripts => ({
    commandFiles: this.commandFiles(),
    scripts: this.ownSessions()
      .filter((session) => session.parentKey === null)
      .map((session) => this.scriptOf(session, null, null)),
    acts: this.acts,
  })

  public readonly has = (capability: string): boolean => this.declaration.capabilities.includes(capability)

  public readonly hasFamily = (family: string): boolean => this.declaration.families.includes(family)

  public readonly modelOf = (session: IPlannedSession): string => this.models.get(session.key) ?? ''

  public readonly childrenOf = (session: IPlannedSession): IPlannedSession[] =>
    this.plan.sessions.filter((candidate) => candidate.parentKey === session.key)

  public readonly scriptedFrom = (session: IPlannedSession): IPlannedSession | undefined =>
    this.plan.sessions.find((candidate) => candidate.startedFrom === session.key)

  // Built once, so a scripted session's script is the same when its host's shell call reads it.
  public readonly scriptOf = (
    session: IPlannedSession,
    task: ISubagentTask | null,
    slots: Readonly<Record<string, string>> | null
  ): ISessionScript => {
    const known = this.built.get(session.key)
    if (known !== undefined) {
      return known
    }
    const script = new SessionScripter(this, session, task, slots).script()
    this.built.set(session.key, script)
    return script
  }

  private readonly ownSessions = (): IPlannedSession[] =>
    this.plan.sessions.filter((session) => session.writer === this.writer)

  private readonly commandFiles = (): ICommandFile[] =>
    Object.entries(this.corpus.commands.files)
      .filter(([, entry]) => entry.capabilities.some(this.has))
      .map(([name, entry]) => ({ name, body: entry.commandFile, projectDir: null }))
}

class SessionScripter {
  private readonly writer: WriterScripter
  private readonly session: IPlannedSession
  private readonly task: ISubagentTask | null
  private readonly stream: IRandomStream
  private readonly slots: Readonly<Record<string, string>>
  private readonly children: IPlannedSession[]
  private readonly steps: ScriptStep[] = []
  private count = 0
  private isTurnStart = false

  constructor(
    writer: WriterScripter,
    session: IPlannedSession,
    task: ISubagentTask | null,
    slots: Readonly<Record<string, string>> | null
  ) {
    this.writer = writer
    this.session = session
    this.task = task
    this.stream = createStream(writer.seed, `${session.key}/script`)
    this.slots = slots ?? this.sessionSlots()
    this.children = writer.childrenOf(session)
  }

  public readonly script = (): ISessionScript => {
    this.session.turns.forEach((turn, index) => {
      this.turn(turn, this.turnPlan(index))
    })
    return {
      key: this.session.key,
      projectDir: this.writer.corpus.projects[this.session.project].directory,
      title: this.session.title,
      agent: this.session.agent,
      gitBranch: this.session.gitBranch,
      isScripted: this.session.origin === 'scripted',
      harnessVersion: null,
      steps: this.steps,
    }
  }

  private readonly sessionSlots = (): Record<string, string> => {
    const sources = this.writer.corpus.projects[this.session.project].files.filter((file) => file.path.includes('/'))
    return { work: this.session.work, file: this.stream.pick(sources).path }
  }

  private readonly key = (letter: string): string => {
    this.count += 1
    return `${this.session.key}:${letter}${String(this.count)}`
  }

  private readonly turnPlan = (index: number): ITurnPlan => {
    const { shapes, prompts, replies } = this.writer.corpus
    if (this.task !== null && index === 0) {
      const shape = { act: this.task.act, uses: this.task.uses, closing: 'done' } as const
      return { shape, prompt: fill(this.task.prompt, this.slots), closing: fill(this.task.result, this.slots) }
    }
    const shape = shapes.shapes[this.session.shape].turns[index] ?? shapes.followUp
    const prompt =
      this.session.origin === 'scripted' && index === 0
        ? this.stream.pick(prompts.opening).openingPrompt
        : this.stream.pick(prompts.byAct[shape.act]).prompt
    return {
      shape,
      prompt: fill(prompt, this.slots),
      closing: fill(this.stream.pick(replies.closing[shape.closing]), this.slots),
    }
  }

  // The turn's opening steps at its start, then each use after a reply, and the closing reply at its end.
  private readonly turn = (turn: IPlannedTurn, plan: ITurnPlan): void => {
    const { shape } = plan
    let at = turn.start
    if (shape.offersTools === true && this.writer.has('tools-offered')) {
      const { offered } = this.writer.corpus.tools
      this.steps.push({ kind: 'event', key: this.key('e'), at, event: { type: 'tools-offered', ...offered } })
    }
    if (shape.builtIn !== undefined && this.writer.has('typed-command')) {
      const model = this.writer.modelOf(this.session)
      this.steps.push({ kind: 'command', key: this.key('m'), at, name: shape.builtIn, arguments: model, body: null })
      at += TYPING_MS
    }
    const command = shape.command === undefined ? null : this.commandStep(shape.command, at)
    if (command === null) {
      const key = this.key('p')
      this.steps.push({ kind: 'prompt', key, at, text: plan.prompt, images: 0 })
      this.writer.acts[key] = shape.act
    } else {
      this.steps.push(command)
    }
    this.isTurnStart = true
    this.layOut(
      at,
      turn.end,
      shape.uses.flatMap((name) => this.use(name) ?? []),
      plan.closing
    )
  }

  // Typed by its name where the writer records typed commands, else as its file's body where it records templates.
  private readonly commandStep = (command: NonNullable<ITurnShape['command']>, at: number): TCommandStep | null => {
    const fields = { kind: 'command', at, name: command.name, arguments: command.arguments } as const
    if (this.writer.has('typed-command')) {
      return { ...fields, key: this.key('m'), body: null }
    }
    if (this.writer.has('template-command')) {
      return { ...fields, key: this.key('m'), body: this.writer.corpus.commands.files[command.name].commandFile }
    }
    return null
  }

  // Splits the turn at each use with its own time; each stretch shares the time its uses leave among its replies.
  private readonly layOut = (from: number, end: number, uses: readonly IUse[], closing: string): void => {
    let cursor = from
    let timed: IUse[] = []
    for (const use of uses) {
      if (use.at === null) {
        timed.push(use)
      } else {
        this.stretch(cursor, use.at, timed, null)
        this.steps.push(...use.write(use.at))
        cursor = use.at + use.durationMs
        timed = []
      }
    }
    this.stretch(cursor, end, timed, closing)
  }

  private readonly stretch = (from: number, end: number, uses: readonly IUse[], closing: string | null): void => {
    const busy = uses.reduce((sum, use) => sum + use.durationMs, 0)
    const replyMs = Math.floor((end - from - busy) / (uses.length + 1))
    if (replyMs < MIN_REPLY_MS) {
      throw new Error(`The turn of ${this.session.key} has no room for its uses from ${String(from)}`)
    }
    let at = from
    for (const use of uses) {
      this.reply(at, at + replyMs, null)
      at += replyMs
      this.steps.push(...use.write(at))
      at += use.durationMs
    }
    this.reply(at, end, closing)
  }

  private readonly reply = (at: number, endAt: number, text: string | null): void => {
    const { reasoning } = this.writer.corpus.replies
    const thinking = this.isTurnStart ? fill(this.stream.pick(reasoning), this.slots) : null
    this.isTurnStart = false
    const model = this.writer.modelOf(this.session)
    const tokens = tokensOf(this.stream, thinking !== null)
    const cost = this.writer.has('reported-cost') ? this.costOf(model, tokens) : null
    this.steps.push({ kind: 'reply', key: this.key('r'), at, endAt, model, text, reasoning: thinking, tokens, cost })
  }

  private readonly costOf = (model: string, tokens: IScriptTokens): number => {
    const rates = this.writer.corpus.rates[model]
    if (rates === undefined) {
      throw new Error(`No rates for the model ${model}`)
    }
    const total =
      (tokens.input ?? 0) * rates.input +
      (tokens.output ?? 0) * rates.output +
      (tokens.cacheRead ?? 0) * rates.cacheRead +
      (tokens.cacheWrite ?? 0) * rates.cacheWrite
    return Math.round(total) / MICRO
  }

  // The use a shape names, or null where the writer cannot record it or the plan holds no session for it.
  private readonly use = (name: UseName): IUse | null => {
    if (name === 'run-scripted') {
      return this.scriptedRun()
    }
    const { subagents } = this.writer.corpus.shapes
    const task = Object.entries(subagents).find(([taskName]) => name === `spawn:${taskName}`)
    if (task !== undefined) {
      return this.spawn(task[1])
    }
    const skill = Object.entries(this.writer.corpus.tools.skills).find(([skillName]) => name === `skill:${skillName}`)
    if (skill !== undefined) {
      const [skillName, { text, durationMs }] = skill
      return {
        at: null,
        durationMs,
        write: (startAt) => [
          { kind: 'skill', key: this.key('k'), name: skillName, text, startAt, endAt: startAt + durationMs },
        ],
      }
    }
    return this.toolUse(name)
  }

  private readonly toolEntry = (name: UseName): IToolEntry => {
    const { project, shared } = this.writer.corpus.tools
    const entry =
      Object.entries(project[this.session.project]).find(([toolName]) => toolName === name) ??
      Object.entries(shared).find(([toolName]) => toolName === name)
    if (entry === undefined) {
      throw new Error(`No tool use ${name} in tools.ts`)
    }
    return entry[1]
  }

  private readonly isRecordable = (entry: IToolEntry): boolean =>
    this.writer.hasFamily(entry.family) && (entry.family !== 'mcp' || this.writer.has('mcp-server'))

  private readonly toolUse = (name: UseName): IUse | null => {
    const entry = this.toolEntry(name)
    if (!this.isRecordable(entry)) {
      return null
    }
    const server =
      entry.family === 'dispatch' && this.writer.has('mcp-server')
        ? this.writer.corpus.tools.dispatchServer
        : entry.server
    return {
      at: null,
      durationMs: entry.durationMs,
      write: (startAt) => [
        this.callStep({ ...entry, server }, startAt),
        ...(entry.family === 'tool-search' && this.writer.has('tools-loaded')
          ? [this.toolsLoaded(startAt + entry.durationMs)]
          : []),
      ],
    }
  }

  private readonly callStep = (entry: IToolEntry, startAt: number): ScriptStep => ({
    kind: 'call',
    key: this.key('c'),
    family: entry.family,
    intent: entry.intent,
    tool: entry.tool,
    server: entry.server,
    input: entry.input,
    status: 'completed',
    result: entry.result,
    startAt,
    endAt: startAt + entry.durationMs,
  })

  private readonly toolsLoaded = (at: number): ScriptStep => ({
    kind: 'event',
    key: this.key('e'),
    at,
    event: { type: 'tools-loaded', tools: this.writer.corpus.tools.loaded },
  })

  // The next session the plan starts in this one, at its own times.
  private readonly spawn = (task: ISubagentTask): IUse | null => {
    const child = this.children.shift()
    if (child === undefined) {
      return null
    }
    return {
      at: child.start,
      durationMs: child.end - child.start,
      write: (startAt) => [
        {
          kind: 'spawn',
          key: this.key('s'),
          agentType: task.agentType,
          prompt: fill(task.prompt, this.slots),
          child: this.writer.scriptOf(child, task, this.slots),
          result: fill(task.result, this.slots),
          startAt,
          endAt: child.end,
        },
      ],
    }
  }

  // The `claude -p` shell call that starts the scripted session at the call's time and prints its answer.
  private readonly scriptedRun = (): IUse | null => {
    const scripted = this.writer.scriptedFrom(this.session)
    if (scripted === undefined || !this.writer.hasFamily('shell')) {
      return null
    }
    const { steps } = this.writer.scriptOf(scripted, null, null)
    const entry: IToolEntry = {
      family: 'shell',
      intent: 'run',
      tool: null,
      server: null,
      input: { command: `claude -p "${firstOf(steps, 'prompt', false)}"` },
      result: firstOf(steps, 'reply', true),
      durationMs: scripted.end + EXIT_MS - scripted.start,
    }
    return { at: scripted.start, durationMs: entry.durationMs, write: (startAt) => [this.callStep(entry, startAt)] }
  }
}

// Each writer's command files and session scripts from the plan, in the writers' order. Pure, like the planner: each
// session draws from its own stream, so equal inputs give equal scripts.
export const scriptPlan = (plan: IPlan, inputs: IScriptInputs): IWriterScripts[] =>
  inputs.writers.map((_writer, index) => new WriterScripter(plan, inputs, index).scripts())
