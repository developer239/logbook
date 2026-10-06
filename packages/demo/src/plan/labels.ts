import {
  LABEL_TASKS,
  type ILabelTaskInfo,
  type LabelTaskName,
  type SessionGoal,
  type SessionOutcome,
} from '@log-book/engine'
import { secondLabelModel } from '../corpus/models.js'
import { createStream } from '../random.js'
import { HOUR_MS, MINUTE_MS } from './calendar.js'
import { indexRecords, type IRecordIndex, type ISessionFacts } from './label-records.js'
import type {
  ILabelPlan,
  IPlan,
  IPlanCorpus,
  IPlannedLabel,
  IPlannedRun,
  IPlannedRunTask,
  DemoSize,
  IWriterScripts,
} from './types.js'

type TValues = Readonly<Record<string, string | null>>

// One record a task labels: the value of each of its fields, null for an optional one left out, and the entries it
// writes as `<key>#<n>`.
interface ITaskRecord {
  key: string
  values: TValues
  entries: readonly TValues[]
}

interface ILabelContext {
  plan: IPlan
  scripts: readonly IWriterScripts[]
  corpus: IPlanCorpus
  index: IRecordIndex
  // The sessions the first run labels: those that ended more than 48 hours before the anchor.
  covered: ReadonlySet<string>
}

interface ISessionLabels {
  goal: SessionGoal
  outcome: SessionOutcome
  summary: string
}

// A run's records of one task, labelled in batches of the task's size.
interface IRunPart {
  task: ILabelTaskInfo
  records: readonly ITaskRecord[]
}

const SECOND_MS = 1000
const COVERED_BEFORE_ANCHOR_MS = 48 * HOUR_MS
const FIRST_RUN_BEFORE_ANCHOR_MS = 47 * HOUR_MS
const SAMPLE_GAP_MS = HOUR_MS
const SAMPLE_RUN_MS = 5 * MINUTE_MS
// Each batch of a task is written this long after the one before it.
const BATCH_MS = 15 * SECOND_MS
// A run's pid is this plus its number: a real pid is a fact of the build machine.
const PID_BASE = 40_000
// By size: how long the first run takes, long enough for every batch of its biggest task, and how many shell calls and
// prompts the second model's sample holds.
const SIZES: Readonly<Record<DemoSize, { firstRunMs: number; shellCalls: number; prompts: number }>> = {
  small: { firstRunMs: 30 * MINUTE_MS, shellCalls: 20, prompts: 2 },
  rich: { firstRunMs: 8 * HOUR_MS, shellCalls: 200, prompts: 20 },
}
// The tasks the second model labels again, in run order.
const SAMPLE_TASKS: readonly LabelTaskName[] = ['shell', 'prompt', 'reply']

const writerScripts = (context: ILabelContext, facts: ISessionFacts): IWriterScripts => {
  const written = context.scripts[facts.writer]
  if (written === undefined) {
    throw new Error(`No scripts for writer ${String(facts.writer)}`)
  }
  return written
}

const coveredFacts = (context: ILabelContext, session: string): ISessionFacts | null => {
  const facts = context.index.sessions.get(session)
  return facts === undefined || !context.covered.has(session) ? null : facts
}

const shellRecords = (context: ILabelContext): ITaskRecord[] =>
  [...context.index.shellCalls].flatMap(([key, session]) => {
    const facts = coveredFacts(context, session)
    if (facts === null) {
      return []
    }
    const labels = writerScripts(context, facts).calls[key]?.shell
    if (labels === undefined || labels === null) {
      throw new Error(`The shell call ${key} has no planned labels`)
    }
    return [{ key, values: { purpose: labels.purpose, failure: labels.failure }, entries: [] }]
  })

// Failed calls outside the shell that the sync's cause rules leave to a model.
const toolFailureRecords = (context: ILabelContext): ITaskRecord[] =>
  [...context.index.failedCalls].flatMap(([key, session]) => {
    const facts = coveredFacts(context, session)
    const failure = facts === null ? null : writerScripts(context, facts).calls[key]?.failure
    return failure === undefined || failure === null || failure.isRuleSettled
      ? []
      : [{ key, values: { cause: failure.cause }, entries: [] }]
  })

// A top-level session's labels come from its plan, a started session's from the task it was started with.
const sessionLabels = (context: ILabelContext, facts: ISessionFacts): ISessionLabels => {
  const { planned } = facts
  if (planned.origin === 'subagent') {
    const name = writerScripts(context, facts).subagents[planned.key]
    if (name === undefined) {
      throw new Error(`The started session ${planned.key} has no task`)
    }
    const { goal, outcome, summary } = context.corpus.shapes.subagents[name]
    return { goal, outcome, summary }
  }
  const item = context.corpus.work[planned.project].find((candidate) => candidate.title === planned.work)
  if (planned.goal === null || planned.outcome === null || item === undefined) {
    throw new Error(`The session ${planned.key} has no planned goal and outcome`)
  }
  return { goal: planned.goal, outcome: planned.outcome, summary: item.summary }
}

const promptedSessions = (context: ILabelContext): ISessionFacts[] =>
  [...context.index.sessions.values()].filter((facts) => facts.hasPrompt && context.covered.has(facts.planned.key))

const sessionRecords = (context: ILabelContext): ITaskRecord[] =>
  promptedSessions(context).map((facts) => {
    const { goal, summary } = sessionLabels(context, facts)
    return { key: facts.planned.key, values: { goal, secondGoal: 'none', summary }, entries: [] }
  })

const outcomeRecords = (context: ILabelContext): ITaskRecord[] =>
  promptedSessions(context).map((facts) => {
    const { outcome } = sessionLabels(context, facts)
    return {
      key: facts.planned.key,
      values: { outcome, outcomeNote: context.corpus.outcomeNotes[outcome] },
      entries: [],
    }
  })

const promptRecords = (context: ILabelContext): ITaskRecord[] =>
  [...context.index.prompts].flatMap(([key, prompt]) => {
    const facts = coveredFacts(context, prompt.session)
    if (facts === null) {
      return []
    }
    const written = writerScripts(context, facts)
    const act = written.acts[key]
    if (act === undefined) {
      throw new Error(`The prompt ${key} has no planned act`)
    }
    const entries = (written.reactions[key] ?? []).map(({ reaction, about, target, reach, steps }) => ({
      reaction,
      about,
      target,
      reach,
      steps: steps.length === 0 ? null : steps.join(','),
    }))
    return [{ key, values: { act }, entries }]
  })

const replyRecords = (context: ILabelContext): ITaskRecord[] =>
  [...context.index.replies].flatMap(([key, reply]) => {
    const facts = coveredFacts(context, reply.session)
    if (facts === null) {
      return []
    }
    const planned = writerScripts(context, facts).replies[key]
    if (planned === undefined) {
      throw new Error(`The reply ${key} has no planned codes`)
    }
    return [{ key, values: { reply: planned.codes.join(','), replyQuote: planned.quote }, entries: [] }]
  })

const TASK_RECORDS: Readonly<Record<LabelTaskName, (context: ILabelContext) => ITaskRecord[]>> = {
  'shell': shellRecords,
  'tool-failure': toolFailureRecords,
  'session': sessionRecords,
  'outcome': outcomeRecords,
  'prompt': promptRecords,
  'reply': replyRecords,
}

const taskNamed = (name: LabelTaskName): ILabelTaskInfo => {
  const task = LABEL_TASKS.find((candidate) => candidate.name === name)
  if (task === undefined) {
    throw new Error(`The engine has no label task ${name}`)
  }
  return task
}

// One row per field the engine's task writes for the record type; a field the plan gives no value for fails.
const fieldRows = (
  task: ILabelTaskInfo,
  recordType: ILabelTaskInfo['recordTypes'][number],
  key: string,
  values: TValues,
  label: Pick<IPlannedLabel, 'labeller' | 'labelledAt' | 'run'>
): IPlannedLabel[] =>
  task.fields
    .filter((field) => field.recordType === recordType)
    .flatMap((field) => {
      const value = values[field.name]
      if (value === undefined || (value === null && !field.isOptional)) {
        throw new Error(`The plan gives no value for the ${task.name} field ${field.name} of ${key}`)
      }
      return value === null
        ? []
        : [{ recordKey: key, recordType, version: task.version, name: field.name, value, ...label }]
    })

const recordRows = (
  task: ILabelTaskInfo,
  record: ITaskRecord,
  label: Pick<IPlannedLabel, 'labeller' | 'labelledAt' | 'run'>
): IPlannedLabel[] => {
  const [main, entryType] = task.recordTypes
  if (main === undefined || (record.entries.length > 0 && entryType === undefined)) {
    throw new Error(`The engine's ${task.name} task has no record type for its entries`)
  }
  return [
    ...fieldRows(task, main, record.key, record.values, label),
    ...record.entries.flatMap((entry, index) =>
      entryType === undefined ? [] : fieldRows(task, entryType, `${record.key}#${String(index + 1)}`, entry, label)
    ),
  ]
}

// Each part in its own stretch of the run, each batch of a part a little after the one before.
const runLabels = (run: IPlannedRun, parts: readonly IRunPart[]): IPlannedLabel[] => {
  const stretch = Math.floor((run.endedAt - run.startedAt) / parts.length)
  return parts.flatMap((part, partIndex) =>
    part.records.flatMap((record, recordIndex) => {
      const labelledAt =
        run.startedAt + partIndex * stretch + (Math.floor(recordIndex / part.task.batchSize) + 1) * BATCH_MS
      if (labelledAt >= run.startedAt + (partIndex + 1) * stretch) {
        throw new Error(`Run ${String(run.number)} has no time left for its ${part.task.name} batches`)
      }
      return recordRows(part.task, record, { labeller: run.model, labelledAt, run: run.number })
    })
  )
}

const runTasks = (parts: readonly IRunPart[]): IPlannedRunTask[] =>
  parts.map(({ task, records }) => ({
    task: task.name,
    version: task.version,
    planned: records.length,
    done: records.length,
  }))

// `count` records picked by the seed, kept in their order.
const sampleOf = (plan: IPlan, name: string, records: readonly ITaskRecord[], count: number): ITaskRecord[] => {
  if (records.length < count) {
    throw new Error(
      `The ${name} sample needs ${String(count)} records and the first run labels ${String(records.length)}`
    )
  }
  const chosen = new Set(createStream(plan.seed, `labels/sample/${name}`).shuffle(records).slice(0, count))
  return records.filter((record) => chosen.has(record))
}

// The second model's sample: shell calls, and prompts with reactions and a reply, with those replies.
const sampleParts = (context: ILabelContext, first: ReadonlyMap<LabelTaskName, readonly ITaskRecord[]>): IRunPart[] => {
  const replies = first.get('reply') ?? []
  const replyKeys = new Set(replies.map((record) => record.key))
  const replied = (first.get('prompt') ?? []).filter((record) => {
    const reply = context.index.prompts.get(record.key)?.reply
    return record.entries.length > 0 && reply !== null && reply !== undefined && replyKeys.has(reply)
  })
  const prompts = sampleOf(context.plan, 'prompt', replied, SIZES[context.plan.size].prompts)
  const sampledReplies = new Set(prompts.map((record) => context.index.prompts.get(record.key)?.reply))
  const records: Readonly<Record<string, readonly ITaskRecord[]>> = {
    shell: sampleOf(context.plan, 'shell', first.get('shell') ?? [], SIZES[context.plan.size].shellCalls),
    prompt: prompts,
    reply: replies.filter((record) => sampledReplies.has(record.key)),
  }
  return SAMPLE_TASKS.map((name) => ({ task: taskNamed(name), records: records[name] ?? [] }))
}

const run = (number: number, command: string, model: string, startedAt: number, length: number): IPlannedRun => ({
  number,
  command,
  model,
  pid: PID_BASE + number,
  startedAt,
  endedAt: startedAt + length,
  outcome: 'ok',
  error: null,
  tasks: [],
})

// The label records and the labelling runs a user's own commands would have made: `logbook labels update` 47 hours
// before the anchor over every session that ended before then, then the second model's sample one task at a time.
// Pure: no model runs, and equal inputs give an equal plan.
export const planLabels = (plan: IPlan, scripts: readonly IWriterScripts[], corpus: IPlanCorpus): ILabelPlan => {
  if (plan.labelModel === null) {
    return { labels: [], runs: [] }
  }
  const index = indexRecords(plan, scripts)
  const covered = new Set(
    plan.sessions
      .filter((session) => session.end < plan.anchor - COVERED_BEFORE_ANCHOR_MS)
      .map((session) => session.key)
  )
  const context: ILabelContext = { plan, scripts, corpus, index, covered }
  const firstParts = LABEL_TASKS.map((task) => ({ task, records: TASK_RECORDS[task.name](context) }))
  const first = run(
    1,
    'logbook labels update',
    plan.labelModel,
    plan.anchor - FIRST_RUN_BEFORE_ANCHOR_MS,
    SIZES[plan.size].firstRunMs
  )
  const second = secondLabelModel(plan.labelModel)
  const sample = sampleParts(context, new Map(firstParts.map((part) => [part.task.name, part.records])))
  const sampleRuns = sample.map((part, sampleIndex) =>
    run(
      sampleIndex + 2,
      `logbook labels run --task ${part.task.name} --sample ${String(part.records.length)} --model ${second}`,
      second,
      first.endedAt + SAMPLE_GAP_MS + sampleIndex * SAMPLE_RUN_MS,
      SAMPLE_RUN_MS
    )
  )
  const runs = [
    { ...first, tasks: runTasks(firstParts) },
    ...sampleRuns.map((sampleRun, sampleIndex) => ({
      ...sampleRun,
      tasks: runTasks(sample.slice(sampleIndex, sampleIndex + 1)),
    })),
  ]
  return {
    labels: [
      ...runLabels(first, firstParts),
      ...sampleRuns.flatMap((sampleRun, sampleIndex) =>
        runLabels(sampleRun, sample.slice(sampleIndex, sampleIndex + 1))
      ),
    ],
    runs,
  }
}
