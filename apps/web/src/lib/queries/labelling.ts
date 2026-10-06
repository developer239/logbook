import { readLabelsLock, resolveWarehousePath, type LabelRunOutcome } from '@log-book/warehouse'
import { EXIT } from '../cli'
import type { IChildExit, ILabellingProcess, PlanResult } from '../labelling'
import { all, get } from '../warehouse'

export type LabellingStateName =
  | 'stopping'
  | 'starting'
  | 'running-here'
  | 'maintenance'
  | 'running-elsewhere'
  | 'updated'
  | 'needs-claude'
  | 'failed'
  | 'never'
  | 'interrupted'
  | 'finished'
  | 'stopped'
  | 'limit'
  | 'unreachable'

export type LabellingTone = 'slow' | 'problem' | 'hollow' | 'good'

// A run's progress from its record: per task (in the order the warehouse returns them) and summed.
export interface ILabelProgress {
  model: string
  startedAt: number
  tasks: { task: string; done: number; planned: number }[]
  done: number
  planned: number
  // The share done, in whole percent.
  percent: number
}

export interface ILabellingState {
  name: LabellingStateName
  tone: LabellingTone
  // When it happened: the lock's start while one holds it, the newest record's end (its start when it never ended),
  // or the time a kept exit happened; null where nothing has.
  at: number | null
  // The record's error or the child's last stderr line for `failed`, the prerequisite line for `needs-claude`.
  detail: string | null
  // What holds the lock in `maintenance`.
  operation: 'compact' | 'forget' | null
  // The running run's progress once its record exists (running here, stopping, running elsewhere).
  progress: ILabelProgress | null
}

export type PlanState = 'ready' | 'nothing' | 'needs-claude' | 'plan-failed' | 'updated'

interface IRunRecord {
  id: number
  pid: number
  startedAt: number
  endedAt: number | null
  outcome: LabelRunOutcome | null
  error: string | null
  model: string
}

const TONES: Record<LabellingStateName, LabellingTone> = {
  'stopping': 'slow',
  'starting': 'slow',
  'running-here': 'slow',
  'maintenance': 'slow',
  'running-elsewhere': 'slow',
  'updated': 'problem',
  'needs-claude': 'problem',
  'failed': 'problem',
  'never': 'hollow',
  'interrupted': 'hollow',
  'finished': 'good',
  'stopped': 'hollow',
  'limit': 'slow',
  'unreachable': 'problem',
}

// The run outcomes the newest record decides once nothing runs and no kept exit applies.
const ENDED: Record<Exclude<LabelRunOutcome, 'failed'>, LabellingStateName> = {
  ok: 'finished',
  stopped: 'stopped',
  limit: 'limit',
  unreachable: 'unreachable',
}

// Exits that have no state of their own: the holder of the lock, or the newest record, says what happened.
const SILENT_EXITS = new Set<number | null>([EXIT.success, EXIT.alreadyRunning, EXIT.interrupted])

const state = (
  name: LabellingStateName,
  rest: Partial<Omit<ILabellingState, 'name' | 'tone'>> = {}
): ILabellingState => ({
  name,
  tone: TONES[name],
  at: null,
  detail: null,
  operation: null,
  progress: null,
  ...rest,
})

const newestRecord = (): IRunRecord | undefined =>
  get<IRunRecord>(
    `SELECT id, pid, started_at AS startedAt, ended_at AS endedAt, outcome, error, model
     FROM label_run ORDER BY id DESC LIMIT 1`
  )

const progressOf = (record: IRunRecord): ILabelProgress => {
  const tasks = all<{ task: string; done: number; planned: number }>(
    'SELECT task, done, planned FROM label_run_task WHERE run_id = ? ORDER BY task',
    record.id
  )
  const done = tasks.reduce((sum, task) => sum + task.done, 0)
  const planned = tasks.reduce((sum, task) => sum + task.planned, 0)

  return {
    model: record.model,
    startedAt: record.startedAt,
    tasks,
    done,
    planned,
    percent: planned === 0 ? 0 : Math.floor((done * 100) / planned),
  }
}

// A record belongs to the process whose pid it holds.
const progressFor = (record: IRunRecord | undefined, pid: number): ILabelProgress | null =>
  record?.pid === pid ? progressOf(record) : null

const hasRecordOf = (pid: number | null): boolean =>
  pid !== null && get<{ one: number }>('SELECT 1 AS one FROM label_run WHERE pid = ? LIMIT 1', pid) !== undefined

// A kept exit stands until a record starts after it.
const isCurrent = (exit: IChildExit | null, record: IRunRecord | undefined): exit is IChildExit =>
  exit !== null && (record === undefined || record.startedAt <= exit.at)

// A run child of this process that failed before it wrote a record has only its exit to tell.
const failedExit = (own: ILabellingProcess, record: IRunRecord | undefined): IChildExit | null => {
  const exit = own.runExit
  return isCurrent(exit, record) && !SILENT_EXITS.has(exit.code) && !hasRecordOf(exit.pid) ? exit : null
}

const recordState = (record: IRunRecord): ILabellingState => {
  if (record.endedAt === null) {
    return state('interrupted', { at: record.startedAt })
  }

  if (record.outcome === null) {
    throw new Error(`The labelling run ${String(record.id)} ended without an outcome`)
  }

  return record.outcome === 'failed'
    ? state('failed', { at: record.endedAt, detail: record.error })
    : state(ENDED[record.outcome], { at: record.endedAt })
}

// What runs now: this process's run child, else what holds the labelling lock.
const runningState = (run: ILabellingProcess['run'], record: IRunRecord | undefined): ILabellingState | null => {
  const lock = readLabelsLock(resolveWarehousePath())

  if (run !== null) {
    const progress = progressFor(record, run.pid)

    if (run.isStopSent) {
      return state('stopping', { progress })
    }

    return progress === null ? state('starting') : state('running-here', { at: progress.startedAt, progress })
  }

  if (lock.isHeld && lock.pid !== null && lock.operation !== null) {
    return lock.operation === 'labels'
      ? state('running-elsewhere', { at: lock.startedAt, progress: progressFor(record, lock.pid) })
      : state('maintenance', { at: lock.startedAt, operation: lock.operation })
  }

  return null
}

// What this process's own children told it, while no record has started since.
const keptExitState = (own: ILabellingProcess, record: IRunRecord | undefined): ILabellingState | null => {
  if (own.isUpdated) {
    return state('updated')
  }

  const missing = [own.planExit, own.runExit]
    .filter((exit) => isCurrent(exit, record))
    .find((exit) => exit.code === EXIT.missingPrerequisite)
  if (missing !== undefined) {
    return state('needs-claude', { at: missing.at, detail: missing.lastLine })
  }

  const failed = failedExit(own, record)
  if (failed !== null) {
    return state('failed', { at: failed.at, detail: failed.lastLine })
  }

  return null
}

// The rows are checked in order, and the first that matches decides: this process's run child, then what holds the
// labelling lock, then the exits this process keeps, then the newest record.
export const labellingState = (own: ILabellingProcess): ILabellingState => {
  const record = newestRecord()

  return (
    runningState(own.run, record) ??
    keptExitState(own, record) ??
    (record === undefined ? state('never') : recordState(record))
  )
}

// Whether any model labelling has run: one cheap statement, where reading `label` for a labeller other than the rules
// would scan the table when only rule labels exist.
export const hasModelLabelling = (): boolean =>
  get<{ one: number }>('SELECT 1 AS one FROM label_run_task WHERE done > 0 LIMIT 1') !== undefined

export const planState = (result: PlanResult): PlanState => {
  if (result.kind === 'plan') {
    return result.plan.records > 0 ? 'ready' : 'nothing'
  }

  if (result.exit.code === EXIT.missingPrerequisite) {
    return 'needs-claude'
  }

  return result.exit.code === EXIT.updatedWhileRunning ? 'updated' : 'plan-failed'
}
