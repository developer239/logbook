import { ago, count } from '../format'
import type { ILabelPlan, PlanResult } from '../labelling'
import {
  planState,
  type ILabelProgress,
  type ILabellingState,
  type LabellingStateName,
  type PlanState,
} from '../queries/labelling'

// The part of /labels each labelling state shows.
export type LabelsPart =
  | 'plan'
  | 'starting'
  | 'running-here'
  | 'stopping'
  | 'running-elsewhere'
  | 'maintenance'
  | 'updated'

const PARTS: Record<LabellingStateName, LabelsPart> = {
  'never': 'plan',
  'finished': 'plan',
  'stopped': 'plan',
  'interrupted': 'plan',
  'limit': 'plan',
  'unreachable': 'plan',
  'failed': 'plan',
  'needs-claude': 'plan',
  'starting': 'starting',
  'running-here': 'running-here',
  'stopping': 'stopping',
  'running-elsewhere': 'running-elsewhere',
  'maintenance': 'maintenance',
  'updated': 'updated',
}

// The states of a last run whose Label control text stands under the heading. `needs-claude` is left out: the plan
// part shows the same prerequisite line.
const LAST_RUN = new Set<LabellingStateName>(['finished', 'stopped', 'interrupted', 'limit', 'unreachable', 'failed'])

// The parts that reload themselves, so the page turns to the plan once the run or the maintenance ends.
const LIVE = new Set<LabelsPart>(['starting', 'running-here', 'stopping', 'running-elsewhere', 'maintenance'])

export const partOf = (state: ILabellingState): LabelsPart => PARTS[state.name]

export const isLastRun = (state: ILabellingState): boolean => LAST_RUN.has(state.name)

export const isLive = (part: LabelsPart): boolean => LIVE.has(part)

export const STARTING = 'Starting: checking Claude Code and counting what to label…'
export const STOPPING = 'Stopping: no new batch starts; finished batches are kept.'
export const UPDATED = 'Log Book was updated while running. Press Ctrl+C and start logbook again.'
export const STOP_TITLE = 'Stop labelling. Finished batches are kept, and Label continues from there.'
export const MODEL_HELP =
  'Claude model id for every task of this run (default claude-haiku-4-5; pass a full id, not an alias). On a fixed 100-prompt sample Haiku agreed with Sonnet on 62% of prompt acts and of reaction sets and missed most redirects and praise.'

export const startTitle = (model: string): string =>
  `Start labelling with ${model}. You can stop it at any time; what is labelled is kept.`

// The words each task names its records with, in the engine's task order.
const TASK_WORDS: Readonly<Record<string, { one: string; many: string }>> = {
  'shell': { one: 'shell call', many: 'shell calls' },
  'tool-failure': { one: 'failed tool call', many: 'failed tool calls' },
  'session': { one: 'session', many: 'sessions' },
  'outcome': { one: 'outcome', many: 'outcomes' },
  'prompt': { one: 'prompt', many: 'prompts' },
  'reply': { one: 'reply', many: 'replies' },
}
const TASK_ORDER = Object.keys(TASK_WORDS)
// A task's word padded so its counts line up: `shell calls    1,200 of 2,140`.
const TASK_COLUMN = 14
const ESTIMATE_DIGITS = 2
const SUBSCRIPTION = 'claude.ai'
const FIRST_PARTY = 'firstParty'

const taskNoun = (task: string, records: number): string => {
  const words = TASK_WORDS[task]
  if (words === undefined) {
    throw new Error(`Labelling names a task this page has no words for: ${task}`)
  }
  return records === 1 ? words.one : words.many
}

const records = (value: number): string => `${count(value)} ${value === 1 ? 'record' : 'records'}`

// The estimate to two significant figures, so it reads as one: about 560,000.
const roughly = (tokens: number): string => count(tokens === 0 ? 0 : Number(tokens.toPrecision(ESTIMATE_DIGITS)))

const toLabelLines = (plan: ILabelPlan): string[] => {
  if (plan.records === 0) {
    return ['To label: nothing. Every record already has a label from a model.']
  }

  const tasks = plan.tasks
    .filter((task) => task.records > 0)
    .map((task) => `${taskNoun(task.task, task.records)} ${count(task.records)}`)
  const agents = plan.harnesses.map((harness) => `${harness.name ?? harness.id} ${count(harness.records)}`)

  return [`To label: ${records(plan.records)} (${tasks.join(', ')}).`, `By agent: ${agents.join(', ')}.`]
}

// What a run would send, in specification 07's words.
const planLines = (plan: ILabelPlan): string[] => {
  const isSubscription = plan.authMethod === SUBSCRIPTION
  const signIn = isSubscription
    ? 'signed in with a Claude subscription'
    : 'signed in with an API key; labelling is billed to that account'
  const provider = plan.apiProvider === null || plan.apiProvider === FIRST_PARTY ? 'Anthropic' : plan.apiProvider

  return [
    `Log Book runs your own claude ${plan.claudeVersion}, ${signIn}, on ${plan.model}.`,
    ...(plan.apiKeyInEnvironment
      ? ['ANTHROPIC_API_KEY is set, so Claude Code may bill this run to that key instead of your plan.']
      : []),
    ...(isSubscription ? ["Requests count against your Claude plan's usage limits."] : []),
    ...toLabelLines(plan),
    `Excerpts of these records go to ${provider} through Claude Code; nothing is redacted.`,
    ...(plan.records === 0
      ? []
      : [
          `Estimated: about ${roughly(plan.estimatedInputTokens)} input tokens. You can stop it at any time; what is labelled is kept.`,
        ]),
  ]
}

// The plan part: what it shows, and the model Start would run with when the plan is ready.
export interface IPlanPart {
  state: PlanState
  lines: string[]
  // The model field and Start, only for a plan with records to label.
  model: string | null
}

export const planPart = (result: PlanResult): IPlanPart => {
  const state = planState(result)

  if (result.kind === 'plan') {
    return { state, lines: planLines(result.plan), model: state === 'ready' ? result.plan.model : null }
  }

  const last = result.exit.lastLine ?? `exit ${String(result.exit.code)}`

  if (state === 'needs-claude') {
    return { state, lines: [last], model: null }
  }

  return { state, lines: [state === 'updated' ? UPDATED : `Could not work out what to label: ${last}`], model: null }
}

// The newest record's progress: a first line, then one line per task with records planned, in task order.
export const progressLines = (progress: ILabelProgress, now: number, isElsewhere: boolean): string[] => {
  const done = `${count(progress.done)} of ${records(progress.planned)} (${String(progress.percent)}%)`
  const started = `${progress.model}, started ${ago(progress.startedAt, now)}: ${done}`
  const tasks = progress.tasks
    .filter((task) => task.planned > 0)
    .toSorted((first, second) => TASK_ORDER.indexOf(first.task) - TASK_ORDER.indexOf(second.task))
    .map(
      (task) => `${taskNoun(task.task, task.planned).padEnd(TASK_COLUMN)} ${count(task.done)} of ${count(task.planned)}`
    )

  return [
    isElsewhere ? `Labelling in a terminal, with ${started}. Stop it there with Ctrl+C.` : `Labelling with ${started}.`,
    ...tasks,
  ]
}
