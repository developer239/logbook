import { isLabelModelId, LABEL_MODEL_RULE } from '@log-book/core'
import { EXIT, lastLineOf, outputOf, startLogbook, type ChildProcess, type IChildRegistry, type ICliRun } from './cli'
import { CliError, ParamError } from './errors'
import { SECOND } from './time'

// A plan that has not exited by then is stopped and counts as a failed plan.
export const PLAN_TIMEOUT_MS = 30 * SECOND

// What `logbook labels plan` prints: what a run would send, to which model, through which Claude Code.
export interface ILabelPlan {
  model: string
  claudeVersion: string
  authMethod: string | null
  apiProvider: string | null
  apiKeyInEnvironment: boolean
  // Every task, in task order.
  tasks: { task: string; records: number }[]
  // Only the harnesses with records to label.
  harnesses: { id: string; name: string | null; records: number }[]
  records: number
  estimatedInputTokens: number
}

// How a child of this process ended: its exit code (null when a signal ended it), its last stderr line and when.
export interface IChildExit {
  pid: number | null
  code: number | null
  lastLine: string | null
  at: number
}

export type PlanResult = { kind: 'plan'; plan: ILabelPlan } | { kind: 'failed'; exit: IChildExit }

// What this process remembers of the labelling children it started, which the warehouse cannot tell.
export interface ILabellingProcess {
  // This process's run child while it lives.
  run: { pid: number; isStopSent: boolean } | null
  // How the last run child exited, until the next start.
  runExit: IChildExit | null
  // How the last plan exited.
  planExit: IChildExit | null
  // A child exited `updated while running`: every later child of this host would too, until logbook restarts.
  isUpdated: boolean
}

interface IRunChild {
  child: ChildProcess
  isStopSent: boolean
}

let planning: Promise<PlanResult> | undefined
let planExit: IChildExit | undefined
let running: IRunChild | undefined
let runExit: IChildExit | undefined
let isUpdated = false

// A model a request names, refused (400) unless it follows the CLI's --model rule; none leaves the CLI's default.
export const checkedModel = (model: string | null): string | null => {
  if (model !== null && !isLabelModelId(model)) {
    throw new ParamError(`The model ${LABEL_MODEL_RULE}, got ${JSON.stringify(model)}`)
  }

  return model
}

// The model as its own argument after --model, so it can never read as an option.
const modelArgs = (model: string | null): string[] => {
  const checked = checkedModel(model)
  return checked === null ? [] : ['--model', checked]
}

const keep = (pid: number | undefined, run: ICliRun): IChildExit => {
  isUpdated ||= run.code === EXIT.updatedWhileRunning
  return { pid: pid ?? null, code: run.code, lastLine: lastLineOf(run), at: Date.now() }
}

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0
const isText = (value: unknown): value is string => typeof value === 'string'
const isTextOrNull = (value: unknown): value is string | null => value === null || isText(value)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isListOf = (value: unknown, isItem: (item: Record<string, unknown>) => boolean): boolean =>
  Array.isArray(value) && value.every((item) => isRecord(item) && isItem(item))

// Which model, through which Claude Code and which account.
const isClaudeOf = (plan: Record<string, unknown>): boolean =>
  isText(plan['model']) &&
  isText(plan['claudeVersion']) &&
  isTextOrNull(plan['authMethod']) &&
  isTextOrNull(plan['apiProvider']) &&
  typeof plan['apiKeyInEnvironment'] === 'boolean'

// What it would label, by task and by harness, and the input it would send.
const isCountsOf = (plan: Record<string, unknown>): boolean =>
  isListOf(plan['tasks'], (task) => isText(task['task']) && isCount(task['records'])) &&
  isListOf(
    plan['harnesses'],
    (harness) => isText(harness['id']) && isTextOrNull(harness['name']) && isCount(harness['records'])
  ) &&
  isCount(plan['records']) &&
  isCount(plan['estimatedInputTokens'])

// The plan is a contract with `logbook labels plan`; anything else it prints is a bug there, not a plan to show.
const planOf = (stdout: string): ILabelPlan => {
  const plan: unknown = JSON.parse(stdout)

  if (!isRecord(plan) || !isClaudeOf(plan) || !isCountsOf(plan)) {
    throw new CliError('logbook labels plan printed something other than a plan.')
  }

  return plan as unknown as ILabelPlan
}

const runPlan = async (args: readonly string[], children?: IChildRegistry): Promise<PlanResult> => {
  const child = startLogbook(args, children)
  const timeout = { isExpired: false }
  const timer = setTimeout(() => {
    timeout.isExpired = true
    child.kill('SIGTERM')
  }, PLAN_TIMEOUT_MS)

  try {
    const run = await outputOf(child)
    const exit = keep(child.pid, timeout.isExpired ? { ...run, code: null } : run)
    planExit = exit
    return exit.code === EXIT.success ? { kind: 'plan', plan: planOf(run.stdout) } : { kind: 'failed', exit }
  } finally {
    clearTimeout(timer)
  }
}

// Runs `logbook labels plan` and waits for it. It writes nothing, takes no lock and calls no model; a request that
// arrives while one runs joins it.
export const plan = async (model: string | null, children?: IChildRegistry): Promise<PlanResult> => {
  const args = ['labels', 'plan', ...modelArgs(model)]
  planning ??= runPlan(args, children).finally(() => {
    planning = undefined
  })
  return planning
}

// Keeps how the run child ended, once it has, until the next start.
const keepRunExit = async (child: ChildProcess): Promise<void> => {
  try {
    runExit = keep(child.pid, await outputOf(child))
  } catch (error) {
    runExit = { pid: child.pid ?? null, code: null, lastLine: String(error), at: Date.now() }
  } finally {
    running = undefined
  }
}

const isAlive = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null

// Starts `logbook labels update` as a registered child and does not wait for it; false while this process's run child
// still lives.
export const startRun = (model: string | null, children?: IChildRegistry): boolean => {
  const args = ['labels', 'update', ...modelArgs(model)]

  if (running !== undefined) {
    return false
  }

  const child = startLogbook(args, children)
  running = { child, isStopSent: false }
  runExit = undefined
  void keepRunExit(child)
  return true
}

// Sends SIGTERM to this process's run child while it lives, and to nothing else: a lock's pid can be a terminal's run,
// or after a crash a reused pid.
export const stopRun = (): boolean => {
  if (running === undefined || !isAlive(running.child)) {
    return false
  }

  running.child.kill('SIGTERM')
  running.isStopSent = true
  return true
}

export const labellingProcess = (): ILabellingProcess => ({
  run:
    running?.child.pid === undefined || !isAlive(running.child)
      ? null
      : { pid: running.child.pid, isStopSent: running.isStopSent },
  runExit: runExit ?? null,
  planExit: planExit ?? null,
  isUpdated,
})
