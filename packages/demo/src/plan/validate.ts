import { isLabelModelId, LogBookError } from '@log-book/core'
import { LABEL_TASKS, type ILabelFieldInfo, type ILabelTaskInfo } from '@log-book/engine'
import { DEMO_ERROR_CODES } from '../errors.js'
import { HOUR_MS } from './calendar.js'
import { indexRecords, type IRecordIndex } from './label-records.js'
import type { ILabelPlan, IPlan, IPlannedLabel, IPlannedRun, IWriterScripts } from './types.js'

interface IFieldOf {
  task: ILabelTaskInfo
  field: ILabelFieldInfo
}

interface IValidation {
  plan: IPlan
  labels: ILabelPlan
  index: IRecordIndex
}

const TEXT_CHARS = 200
const QUOTE_WORDS = 15
const REACTION_KEY = /^(?<prompt>.+)#(?<number>[1-9]\d*)$/u

const invalid = (key: string, field: string, reason: string): LogBookError =>
  new LogBookError(`Plan record ${key}, field ${field}: ${reason}.`, DEMO_ERROR_CODES.DEMO_PLAN_INVALID)

const fieldOf = (label: Pick<IPlannedLabel, 'recordType' | 'name'>): IFieldOf | undefined =>
  LABEL_TASKS.flatMap((task) =>
    task.fields
      .filter((field) => field.recordType === label.recordType && field.name === label.name)
      .map((field) => ({ task, field }))
  )[0]

const taskOf = (label: IPlannedLabel): IFieldOf => {
  const found = fieldOf(label)
  if (found === undefined) {
    throw invalid(label.recordKey, label.name, `no engine task writes this field on a ${label.recordType}`)
  }
  return found
}

// The labels of one record as one labelling wrote them.
const groupsOf = (labels: readonly IPlannedLabel[]): Map<string, IPlannedLabel[]> => {
  const groups = new Map<string, IPlannedLabel[]>()
  for (const label of labels) {
    const key = JSON.stringify([label.run, label.recordType, label.recordKey])
    groups.set(key, [...(groups.get(key) ?? []), label])
  }
  return groups
}

// Every field is one an engine task writes, and every field it always writes is there.
const checkFields = ({ labels }: IValidation): void => {
  for (const group of groupsOf(labels.labels).values()) {
    const [first] = group
    if (first === undefined) {
      continue
    }
    const { task } = taskOf(first)
    const names = new Set(group.map((label) => taskOf(label).field.name))
    const missing = task.fields.find(
      (field) => field.recordType === first.recordType && !field.isOptional && !names.has(field.name)
    )
    if (missing !== undefined) {
      throw invalid(first.recordKey, missing.name, `the ${task.name} task always writes it`)
    }
  }
}

const checkValues = ({ labels }: IValidation): void => {
  for (const label of labels.labels) {
    const { field } = taskOf(label)
    const values = field.kind === 'codes' ? label.value.split(',') : [label.value]
    if (field.values !== null && values.some((value) => field.values?.includes(value) !== true)) {
      throw invalid(label.recordKey, label.name, `${label.value} is not in the engine's vocabulary`)
    }
  }
}

const checkTexts = ({ labels, index }: IValidation): void => {
  for (const label of labels.labels) {
    if (taskOf(label).field.kind === 'text' && Array.from(label.value).length > TEXT_CHARS) {
      throw invalid(label.recordKey, label.name, `the text is longer than ${String(TEXT_CHARS)} characters`)
    }
    if (label.name !== 'replyQuote') {
      continue
    }
    if (label.value.split(/\s+/u).length > QUOTE_WORDS) {
      throw invalid(label.recordKey, label.name, `the quote is longer than ${String(QUOTE_WORDS)} words`)
    }
    if (index.replies.get(label.recordKey)?.text.includes(label.value) !== true) {
      throw invalid(label.recordKey, label.name, 'the quote is not in its reply')
    }
  }
}

// The prompt a reaction belongs to and its number, or null for a key not of that form.
const reactionOf = (key: string): { prompt: string; number: number } | null => {
  const groups = REACTION_KEY.exec(key)?.groups
  return groups?.prompt === undefined ? null : { prompt: groups.prompt, number: Number(groups.number) }
}

const isTarget = (index: IRecordIndex, label: IPlannedLabel, task: ILabelTaskInfo): boolean => {
  const key = label.recordKey
  const targets: Readonly<Record<ILabelTaskInfo['name'], () => boolean>> = {
    'shell': () => index.shellCalls.has(key),
    'tool-failure': () => index.failedCalls.has(key),
    'session': () => index.sessions.get(key)?.hasPrompt === true,
    'outcome': () => index.sessions.get(key)?.hasPrompt === true,
    'prompt': () => index.prompts.has(label.recordType === 'reaction' ? (reactionOf(key)?.prompt ?? '') : key),
    'reply': () => index.replies.has(key),
  }
  return targets[task.name]()
}

const checkTargets = ({ labels, index }: IValidation): void => {
  for (const label of labels.labels) {
    const { task } = taskOf(label)
    if (!isTarget(index, label, task)) {
      throw invalid(label.recordKey, label.name, `the ${task.name} task labels no such record`)
    }
  }
}

// Each prompt's reactions numbered from 1 with no gap, their steps calls of the turn before it.
const checkReactions = ({ labels, index }: IValidation): void => {
  const numbers = new Map<string, Set<number>>()
  for (const label of labels.labels.filter((candidate) => candidate.recordType === 'reaction')) {
    const reaction = reactionOf(label.recordKey)
    if (reaction === null) {
      throw invalid(label.recordKey, label.name, 'a reaction id is not <message id>#<n>')
    }
    const prompt = `${String(label.run)} ${reaction.prompt}`
    numbers.set(prompt, (numbers.get(prompt) ?? new Set()).add(reaction.number))
    const previous = index.prompts.get(reaction.prompt)?.previousCalls ?? []
    if (label.name === 'steps' && label.value.split(',').some((step) => !previous.includes(step))) {
      throw invalid(label.recordKey, label.name, 'a step is not a tool call of the turn before the prompt')
    }
  }
  for (const [prompt, seen] of numbers) {
    const gap = Array.from({ length: seen.size }, (_number, number) => number + 1).find((number) => !seen.has(number))
    if (gap !== undefined) {
      throw invalid(`${prompt.slice(prompt.indexOf(' ') + 1)}#${String(gap)}`, 'reaction', 'the reactions have a gap')
    }
  }
}

const runOf = (labels: ILabelPlan, label: IPlannedLabel): IPlannedRun => {
  const found = labels.runs.find((candidate) => candidate.number === label.run)
  if (found === undefined) {
    throw invalid(label.recordKey, label.name, `no run ${String(label.run)} writes it`)
  }
  return found
}

const checkModel = ({ labels }: IValidation): void => {
  const [first, ...later] = labels.runs
  for (const run of labels.runs) {
    if (!isLabelModelId(run.model)) {
      throw invalid(`run ${String(run.number)}`, 'model', `${run.model} is not a model id`)
    }
  }
  const same = later.find((run) => run.model === first?.model)
  if (same !== undefined) {
    throw invalid(`run ${String(same.number)}`, 'model', 'the second model is the labelling model')
  }
  const other = labels.labels.find((label) => label.labeller !== runOf(labels, label).model)
  if (other !== undefined) {
    throw invalid(other.recordKey, other.name, 'its labeller is not the model of its run')
  }
}

// What each run labels in a task: its records of the task's main record type, a prompt once with its reactions.
const labelledIn = (labels: ILabelPlan, run: number, task: ILabelTaskInfo): Set<string> =>
  new Set(
    labels.labels
      .filter((label) => label.run === run && label.recordType === task.recordTypes[0] && taskOf(label).task === task)
      .map((label) => label.recordKey)
  )

const checkRuns = ({ labels }: IValidation): void => {
  for (const run of labels.runs) {
    for (const entry of run.tasks) {
      const task = LABEL_TASKS.find((candidate) => candidate.name === entry.task)
      const count = task === undefined ? -1 : labelledIn(labels, run.number, task).size
      if (entry.planned !== count || entry.done !== count) {
        throw invalid(`run ${String(run.number)}`, `${entry.task} planned`, `the run labels ${String(count)} records`)
      }
    }
  }
  const first = new Set(labels.labels.filter((label) => label.run === 1).map((label) => label.recordKey))
  const unlabelled = labels.labels.find((label) => label.run > 1 && !first.has(label.recordKey))
  if (unlabelled !== undefined) {
    throw invalid(unlabelled.recordKey, unlabelled.name, `run ${String(unlabelled.run)} labels a record run 1 did not`)
  }
}

// The session a label's record is in.
const sessionOf = (index: IRecordIndex, label: IPlannedLabel): string | undefined => {
  const key = label.recordType === 'reaction' ? (reactionOf(label.recordKey)?.prompt ?? '') : label.recordKey
  const owners = [
    index.shellCalls.get(key),
    index.failedCalls.get(key),
    index.prompts.get(key)?.session,
    index.replies.get(key)?.session,
  ]
  return owners.find((owner) => owner !== undefined) ?? (index.sessions.has(key) ? key : undefined)
}

const checkRunTimes = ({ plan, labels }: IValidation): void => {
  const late = labels.runs.find((run) => run.endedAt >= plan.anchor)
  if (late !== undefined) {
    throw invalid(`run ${String(late.number)}`, 'endedAt', 'the run ends after the anchor')
  }
  const outside = labels.labels.find((label) => {
    const run = runOf(labels, label)
    return label.labelledAt < run.startedAt || label.labelledAt > run.endedAt
  })
  if (outside !== undefined) {
    throw invalid(outside.recordKey, outside.name, 'it is labelled outside its run')
  }
}

const checkSessionTimes = ({ plan, labels, index }: IValidation): void => {
  const [first] = labels.runs
  if (first === undefined) {
    return
  }
  const busy = plan.sessions.find(
    (session) => session.end > first.startedAt - HOUR_MS && session.start < first.startedAt
  )
  if (busy !== undefined) {
    throw invalid(busy.key, 'labelledAt', 'the session runs in the hour before run 1')
  }
  for (const label of labels.labels) {
    const facts = index.sessions.get(sessionOf(index, label) ?? '')
    if (facts === undefined || facts.planned.end > first.startedAt) {
      throw invalid(label.recordKey, label.name, 'its session ends after run 1 starts')
    }
    if (label.run === 1 && first.startedAt < facts.newestAt + HOUR_MS) {
      throw invalid(label.recordKey, label.name, 'run 1 starts within the hour after its session')
    }
  }
}

const CHECKS: readonly ((validation: IValidation) => void)[] = [
  checkFields,
  checkValues,
  checkTexts,
  checkTargets,
  checkReactions,
  checkModel,
  checkRuns,
  checkRunTimes,
  checkSessionTimes,
]

// Refuses a plan the engine's tasks could not have written, naming the record key and the field, before any file is
// written.
export const validateLabelPlan = (plan: IPlan, scripts: readonly IWriterScripts[], labels: ILabelPlan): void => {
  const validation = { plan, labels, index: indexRecords(plan, scripts) }
  for (const check of CHECKS) {
    check(validation)
  }
}
