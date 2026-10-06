import type {
  ICommandFile,
  IScriptTokens,
  ISessionScript,
  ScriptCallStatus,
  ScriptEvent,
  ScriptStep,
} from '@log-book/adapter-api/source-writer'
import type { PromptAct } from '@log-book/engine'
import type { IReactionTag } from '../corpus/prompts.js'
import type { ClosingKind } from '../corpus/replies.js'
import {
  SUBAGENT_TASK_NAMES,
  type ISubagentTask,
  type ITurnShape,
  type SubagentTaskName,
  type TurnEvent,
  type UseName,
} from '../corpus/shapes.js'
import type { IToolEntry } from '../corpus/tools.js'
import { createStream, type IRandomStream } from '../random.js'
import { DAY_MS, dayStart } from './calendar.js'
import { humanTurns } from './human-turns.js'
import type {
  ICallLabels,
  IPlan,
  IPlannedReaction,
  IPlannedReply,
  IPlanCorpus,
  IPlannedSession,
  IPlannedTurn,
  IWriterDeclaration,
  IWriterScripts,
} from './types.js'

type TCommandStep = Extract<ScriptStep, { kind: 'command' }>
type TStop = NonNullable<ITurnShape['stop']>

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

// A turn's last reply, and the reply codes planned for it in an interactive session.
interface IClosing {
  text: string
  reply: IPlannedReply | null
}

// What a turn opens with, the developer's reactions its prompt carries, and how its last reply reads.
interface ITurnPlan {
  shape: ITurnShape
  prompt: string
  reactions: readonly IReactionTag[]
  closing: IClosing
}

const SECOND_MS = 1000
// The pause between a built-in command and the prompt typed after it.
const TYPING_MS = 3 * SECOND_MS
// The shortest reply: a turn with no room for its uses fails rather than squeezing them.
const MIN_REPLY_MS = SECOND_MS
// The `claude -p` call exits a moment after the session it started ends.
const EXIT_MS = SECOND_MS
const MICRO = 1_000_000
const STOP_CAPABILITIES: Readonly<Record<TStop, string>> = { interrupt: 'interrupt', refuse: 'tool-reject' }
const STOP_STATUSES: Readonly<Record<TStop, ScriptCallStatus>> = { interrupt: 'pending', refuse: 'rejected' }
const EVENT_CAPABILITIES: Readonly<Record<TurnEvent, string | null>> = {
  'compaction': null,
  'failed-request': null,
  'agent-switch': 'agent-switch',
  'model-switch': 'model-switch',
  'idle': 'idle-event',
}
const OPENING_EVENTS: readonly TurnEvent[] = ['compaction', 'agent-switch', 'model-switch']
// The rich set's story, in percent of the turns it may touch: in the first half of its weeks the developer often
// corrects a "done" said without running the tests and seldom praises; in the second half, asking for the tests in the
// task itself, they correct seldom and praise often. A model's habit ends a plainly ending turn its own way.
const STORY_PERCENT = {
  earlier: { correction: 30, praise: 8, testsInTask: 0 },
  later: { correction: 6, praise: 30, testsInTask: 60 },
} as const
const WEEK_DAYS = 7
const PLAIN_CLOSINGS: ReadonlySet<ClosingKind> = new Set(['progress', 'done'])
const SLOT = /\{(?<name>[a-z]+)\}/gu
const QUOTE = /\[\[(?<quote>.+?)\]\]/u
const QUOTE_MARKS = /\[\[|\]\]/gu

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
  public readonly calls: Record<string, ICallLabels> = {}
  public readonly reactions: Record<string, IPlannedReaction[]> = {}
  public readonly replies: Record<string, IPlannedReply> = {}
  public readonly subagents: Record<string, SubagentTaskName> = {}
  // The first top-level interactive session of the plan, in either writer.
  public readonly firstSession: string | null
  private readonly plan: IPlan
  private readonly declaration: IWriterDeclaration
  private readonly writer: number
  private readonly models = new Map<string, string>()
  private readonly built = new Map<string, ISessionScript>()

  constructor(plan: IPlan, inputs: IScriptInputs, writer: number, firstSession: string | null) {
    const declaration = inputs.writers[writer]
    if (declaration === undefined || declaration.models.length === 0) {
      throw new Error(`Writer ${String(writer)} declares no model`)
    }
    this.plan = plan
    this.corpus = inputs.corpus
    this.seed = plan.seed
    this.declaration = declaration
    this.writer = writer
    this.firstSession = firstSession
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
    reactions: this.reactions,
    replies: this.replies,
    calls: this.calls,
    subagents: this.subagents,
  })

  public readonly has = (capability: string): boolean => this.declaration.capabilities.includes(capability)

  public readonly isRich = (): boolean => this.plan.size === 'rich'

  // Whether a time falls in the second half of the plan's weeks, where the story's developer asks for the tests first.
  public readonly isLaterHalf = (at: number): boolean => {
    const weeks = this.plan.days / WEEK_DAYS
    const week = Math.floor((at - dayStart(this.plan.anchor, 0, this.plan.days)) / (WEEK_DAYS * DAY_MS))
    return week >= weeks / 2
  }

  public readonly hasFamily = (family: string): boolean => this.declaration.families.includes(family)

  public readonly modelOf = (session: IPlannedSession): string => this.models.get(session.key) ?? ''

  // The model after this one in the writer's list, or null when it declares only one.
  public readonly nextModel = (model: string): string | null => {
    const { models } = this.declaration
    return models.length < 2 ? null : (models[(models.indexOf(model) + 1) % models.length] ?? null)
  }

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
  private model: string
  // The calls since the last human prompt and between the two before it, null before the session's first; and whether
  // the turn before was stopped.
  private callsSincePrompt: string[] | null = null
  private previousCalls: string[] | null = null
  private wasStopped = false

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
    this.model = writer.modelOf(session)
  }

  public readonly script = (): ISessionScript => {
    this.session.turns.forEach((turn, index) => {
      this.turn(turn, this.turnPlan(index))
    })
    this.keepSelectedReplies()
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

  // Reply codes stay only on the agent's last text before each next human prompt, the replies the engine labels: a
  // turn a typed command opens has no human prompt of its own.
  private readonly keepSelectedReplies = (): void => {
    const selected = new Set(humanTurns(this.steps).flatMap((turn) => (turn.reply === null ? [] : [turn.reply.key])))
    for (const step of this.steps) {
      if (step.kind === 'reply' && !selected.has(step.key)) {
        Reflect.deleteProperty(this.writer.replies, step.key)
      }
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
    const { shapes, prompts } = this.writer.corpus
    if (this.task !== null && index === 0) {
      const shape = { act: this.task.act, uses: this.task.uses, closing: 'done' } as const
      const closing = { text: fill(this.task.result, this.slots), reply: null }
      return { shape, prompt: fill(this.task.prompt, this.slots), reactions: [], closing }
    }
    const shape = shapes.shapes[this.session.shape].turns[index] ?? this.followUp()
    const isInteractive = this.task === null && this.session.origin === 'interactive'
    const at = this.session.turns[index]?.start ?? this.session.start
    const reaction = isInteractive && index > 0 ? this.turnReaction(index, shape, at) : undefined
    if (reaction !== undefined) {
      const template = this.stream.pick(prompts.reactions[reaction].filter((candidate) => candidate.act === shape.act))
      return {
        shape,
        prompt: fill(template.prompt, this.slots),
        reactions: template.reactions,
        closing: this.closingOf(this.habitOf(shape.closing, isInteractive), isInteractive),
      }
    }
    return {
      shape,
      prompt: fill(this.promptOf(index, shape, isInteractive, at), this.slots),
      reactions: [],
      closing: this.closingOf(this.habitOf(shape.closing, isInteractive), isInteractive),
    }
  }

  // The small set's one follow-up turn, or one of the rich set's longer ones.
  private readonly followUp = (): ITurnShape => {
    const { shapes } = this.writer.corpus
    return this.writer.isRich() ? this.stream.pick(shapes.richFollowUps) : shapes.followUp
  }

  private readonly isRolled = (percent: number): boolean => this.stream.integer(1, 100) <= percent

  // A turn's own reaction, or the rich set's story where it has none.
  private readonly turnReaction = (index: number, shape: ITurnShape, at: number): ITurnShape['reaction'] =>
    this.reactionOf(index, shape) ?? this.storyReaction(shape, at)

  // A scripted session opens with its opening prompt; a task of the rich set's later weeks often asks for the tests in
  // the task itself.
  private readonly promptOf = (index: number, shape: ITurnShape, isInteractive: boolean, at: number): string => {
    const { prompts } = this.writer.corpus
    if (this.session.origin === 'scripted' && index === 0) {
      return this.stream.pick(prompts.opening).openingPrompt
    }
    const story = this.writer.isLaterHalf(at) ? STORY_PERCENT.later : STORY_PERCENT.earlier
    const isWithTests =
      this.writer.isRich() && isInteractive && shape.act === 'task' && this.isRolled(story.testsInTask)
    return isWithTests ? this.stream.pick(prompts.withTests).prompt : this.stream.pick(prompts.byAct[shape.act]).prompt
  }

  // The rich set's story on a turn that goes on with the work and has no reaction of its own.
  private readonly storyReaction = (shape: ITurnShape, at: number): ITurnShape['reaction'] => {
    if (!this.writer.isRich() || shape.act !== 'continue') {
      return undefined
    }
    const story = this.writer.isLaterHalf(at) ? STORY_PERCENT.later : STORY_PERCENT.earlier
    const roll = this.stream.integer(1, 100)
    if (roll <= story.correction) {
      return 'claimed-untested'
    }
    return roll <= story.correction + story.praise ? 'small-and-clean' : undefined
  }

  // In the rich set, a model's habit ends a plainly ending turn of an interactive session its own way.
  private readonly habitOf = (closing: ClosingKind, isInteractive: boolean): ClosingKind => {
    const habit = this.writer.corpus.habits[this.model]
    if (!this.writer.isRich() || !isInteractive || habit === undefined || !PLAIN_CLOSINGS.has(closing)) {
      return closing
    }
    return this.isRolled(habit.percent) ? habit.closing : closing
  }

  // The second turn of the plan's first session takes the first-week reactions; a turn after a stop, its shape's
  // reactions for that.
  private readonly reactionOf = (index: number, shape: ITurnShape): ITurnShape['reaction'] => {
    if (index === 1 && this.writer.firstSession === this.session.key) {
      return 'first-week'
    }
    if (!this.wasStopped) {
      return shape.reaction
    }
    if (shape.afterStop === undefined) {
      throw new Error(`The shape ${this.session.shape} has no reaction for the turn after a stop`)
    }
    return shape.afterStop
  }

  // The text without its quote marks, and in an interactive session its codes and the words its quote copies.
  private readonly closingOf = (kind: ClosingKind, isInteractive: boolean): IClosing => {
    const templates = this.writer.corpus.replies.closing[kind]
    const marked = fill(this.stream.pick(templates.texts), this.slots)
    const quote = QUOTE.exec(marked)?.groups?.quote ?? null
    return {
      text: marked.replaceAll(QUOTE_MARKS, ''),
      reply: isInteractive ? { codes: [...templates.codes], quote } : null,
    }
  }

  // The turn's opening steps at its start, then each use after a reply, and the closing reply at its end, or the
  // developer stopping the agent at its last use.
  private readonly turn = (turn: IPlannedTurn, plan: ITurnPlan): void => {
    const { shape } = plan
    const from = this.openTurn(turn.start, plan)
    const stop = shape.stop === undefined || !this.writer.has(STOP_CAPABILITIES[shape.stop]) ? null : shape.stop
    const names = shape.stop === undefined ? shape.uses : shape.uses.slice(0, -1)
    const uses = names.flatMap((name) => this.use(name) ?? [])
    const stopped = stop === null ? null : this.stoppedUse(shape.uses.at(-1), stop, turn.end)
    if (stopped === null) {
      this.layOut(from, turn.end, uses, plan.closing)
    } else {
      this.layOut(from, turn.end, [...uses, stopped], null)
    }
    if (stopped !== null && stop === 'interrupt') {
      this.steps.push({ kind: 'interrupt', key: this.key('i'), at: turn.end })
    }
    this.wasStopped = stopped !== null
    this.event(shape, 'idle', turn.end)
  }

  // The events at the turn's start, a built-in command, then its prompt or command; returns when its replies start.
  private readonly openTurn = (start: number, plan: ITurnPlan): number => {
    const { shape } = plan
    let at = start
    for (const type of OPENING_EVENTS) {
      this.event(shape, type, at)
    }
    if (shape.offersTools === true && this.writer.has('tools-offered')) {
      const { offered } = this.writer.corpus.tools
      this.steps.push({ kind: 'event', key: this.key('e'), at, event: { type: 'tools-offered', ...offered } })
    }
    if (shape.builtIn !== undefined && this.writer.has('typed-command')) {
      this.steps.push({
        kind: 'command',
        key: this.key('m'),
        at,
        name: shape.builtIn,
        arguments: this.model,
        body: null,
      })
      at += TYPING_MS
    }
    this.openWith(plan, at)
    this.event(shape, 'failed-request', at)
    this.isTurnStart = true
    return at
  }

  // The turn's command where the writer records it, else its prompt; a template command's body is the human's prompt.
  private readonly openWith = (plan: ITurnPlan, at: number): void => {
    const { shape } = plan
    const command = shape.command === undefined ? null : this.commandStep(shape.command, at)
    if (command === null) {
      const key = this.key('p')
      this.steps.push({ kind: 'prompt', key, at, text: plan.prompt, images: 0 })
      this.humanPrompt(key, shape.act)
      this.addReactions(key, plan.reactions)
      return
    }
    this.steps.push(command)
    if (command.body !== null && shape.command !== undefined) {
      this.humanPrompt(command.key, this.writer.corpus.commands.files[shape.command.name].act)
    }
  }

  // A prompt or a template command: what the human typed as the warehouse records it, with its act.
  private readonly humanPrompt = (key: string, act: PromptAct): void => {
    this.writer.acts[key] = act
    this.previousCalls = this.callsSincePrompt
    this.callsSincePrompt = []
  }

  // Numbered from 1; a reaction with steps points at the last call between the human prompt before and this one, and
  // has none at the session's first human prompt.
  private readonly addReactions = (key: string, tags: readonly IReactionTag[]): void => {
    if (tags.length === 0) {
      return
    }
    this.writer.reactions[key] = tags.map(({ hasSteps, ...tag }, index) => ({
      number: index + 1,
      ...tag,
      steps: hasSteps && this.previousCalls !== null ? this.previousCalls.slice(-1) : [],
    }))
  }

  // An event the turn's shape names, where the writer records it.
  private readonly event = (shape: ITurnShape, type: TurnEvent, at: number): void => {
    const capability = EVENT_CAPABILITIES[type]
    if (shape.events?.includes(type) !== true || (capability !== null && !this.writer.has(capability))) {
      return
    }
    const event = this.eventOf(type)
    if (event !== null) {
      this.steps.push({ kind: 'event', key: this.key('e'), at, event })
    }
  }

  private readonly eventOf = (type: TurnEvent): ScriptEvent | null => {
    const { replies } = this.writer.corpus
    if (type === 'compaction') {
      return { type, summary: fill(this.stream.pick(replies.compactions), this.slots) }
    }
    if (type === 'failed-request') {
      return { type, error: this.stream.pick(replies.requestErrors) }
    }
    if (type === 'agent-switch') {
      return { type, agent: this.stream.pick(replies.agents) }
    }
    if (type === 'idle') {
      return { type, outcome: replies.idleOutcome }
    }
    return this.modelSwitch()
  }

  // Replies after the switch come from the next of the writer's models.
  private readonly modelSwitch = (): ScriptEvent | null => {
    const next = this.writer.nextModel(this.model)
    if (next === null) {
      return null
    }
    const previous = this.model
    this.model = next
    return { type: 'model-switch', model: next, previous }
  }

  // The turn's last use, ending at the turn's end: still running when the developer interrupts, or refused when it
  // was asked.
  private readonly stoppedUse = (name: UseName | undefined, stop: TStop, end: number): IUse | null => {
    const use = name === undefined ? null : this.toolUse(name, stop)
    return use === null ? null : { ...use, at: end - use.durationMs }
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
  // Without a closing reply, the last use ends the turn.
  private readonly layOut = (from: number, end: number, uses: readonly IUse[], closing: IClosing | null): void => {
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
    if (closing !== null) {
      this.stretch(cursor, end, timed, closing)
    } else if (timed.length > 0 || cursor !== end) {
      throw new Error(`The turn of ${this.session.key} ends before its last use`)
    }
  }

  private readonly stretch = (from: number, end: number, uses: readonly IUse[], closing: IClosing | null): void => {
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

  private readonly reply = (at: number, endAt: number, closing: IClosing | null): void => {
    const { reasoning } = this.writer.corpus.replies
    const thinking = this.isTurnStart ? fill(this.stream.pick(reasoning), this.slots) : null
    this.isTurnStart = false
    const { model } = this
    const tokens = tokensOf(this.stream, thinking !== null)
    const cost = this.writer.has('reported-cost') ? this.costOf(model, tokens) : null
    const key = this.key('r')
    const text = closing?.text ?? null
    this.steps.push({ kind: 'reply', key, at, endAt, model, text, reasoning: thinking, tokens, cost })
    if (closing !== null && closing.reply !== null) {
      this.writer.replies[key] = closing.reply
    }
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
    const task = SUBAGENT_TASK_NAMES.find((taskName) => name === `spawn:${taskName}`)
    if (task !== undefined) {
      return this.spawn(task, this.writer.corpus.shapes.subagents[task])
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
    return this.toolUse(name, null)
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

  private readonly toolUse = (name: UseName, stop: TStop | null): IUse | null => {
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
        this.callStep({ ...entry, server }, startAt, stop),
        ...(entry.family === 'tool-search' && this.writer.has('tools-loaded')
          ? [this.toolsLoaded(startAt + entry.durationMs)]
          : []),
      ],
    }
  }

  // A stopped call keeps no result: a running one has no end yet, a refused one ends when it was refused.
  private readonly callStep = (entry: IToolEntry, startAt: number, stop: TStop | null): ScriptStep => {
    const key = this.key('c')
    this.callsSincePrompt?.push(key)
    const status = stop === null ? entry.status : STOP_STATUSES[stop]
    this.writer.calls[key] = { shell: entry.shell, failure: status === 'error' ? entry.failure : null }
    return {
      kind: 'call',
      key,
      family: entry.family,
      intent: entry.intent,
      tool: entry.tool,
      server: entry.server,
      input: entry.input,
      status,
      result: stop === null ? entry.result : null,
      startAt,
      endAt: stop === 'interrupt' ? null : startAt + entry.durationMs,
    }
  }

  private readonly toolsLoaded = (at: number): ScriptStep => ({
    kind: 'event',
    key: this.key('e'),
    at,
    event: { type: 'tools-loaded', tools: this.writer.corpus.tools.loaded },
  })

  // The next session the plan starts in this one, at its own times.
  private readonly spawn = (name: SubagentTaskName, task: ISubagentTask): IUse | null => {
    const child = this.children.shift()
    if (child === undefined) {
      return null
    }
    this.writer.subagents[child.key] = name
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
      status: 'completed',
      result: firstOf(steps, 'reply', true),
      durationMs: scripted.end + EXIT_MS - scripted.start,
      shell: this.writer.corpus.tools.scriptedRun,
      failure: null,
    }
    return {
      at: scripted.start,
      durationMs: entry.durationMs,
      write: (startAt) => [this.callStep(entry, startAt, null)],
    }
  }
}

// Each writer's command files and session scripts from the plan, in the writers' order. Pure, like the planner: each
// session draws from its own stream, so equal inputs give equal scripts.
export const scriptPlan = (plan: IPlan, inputs: IScriptInputs): IWriterScripts[] => {
  const first = plan.sessions.find((session) => session.parentKey === null && session.origin === 'interactive')
  return inputs.writers.map((_writer, index) => new WriterScripter(plan, inputs, index, first?.key ?? null).scripts())
}
