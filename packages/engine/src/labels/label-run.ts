import { homedir } from 'node:os'
import { takeLabelsLock, WarehouseStore, type LabelRunOutcome } from '@log-book/warehouse'
import { inLabelDirectory } from '../claude/claude-process.js'
import { detectClaude, type ClaudeMissing } from '../claude/detect.js'
import { withHomeAsTilde } from '../home-path.js'
import { buildLabelFacts, type ILabelFacts } from './facts.js'
import { labelModelOf } from './plan.js'
import {
  runLabelTask,
  type ILabelTaskResult,
  type ILabelTaskStop,
  type TPendingSelection,
} from './runner/label-runner.js'
import type { ILabelRunTask } from './runner/label-task.js'
import type { LabelTaskName } from './tasks.js'
import { labelRunTasks } from './tasks/all-tasks.js'

export interface ILabelRunTaskCounts {
  task: LabelTaskName
  planned: number
  done: number
  unanswered: number
}

export interface ILabelRunReport {
  readonly status: 'ran'
  outcome: LabelRunOutcome
  // For `failed`: a missing prerequisite, named as detection names it (authentication refused, the binary gone), or
  // another failure.
  failureKind: 'not-signed-in' | 'not-found' | 'failure' | null
  tasks: ILabelRunTaskCounts[]
  totals: { planned: number; done: number; unanswered: number; inputTokens: number; outputTokens: number }
  // The record's error, in the `~/` form.
  error: string | null
  durationMs: number
}

export type LabelRunResult = ILabelRunReport | { readonly status: 'missing'; readonly missing: ClaudeMissing }

export type LabelPreflight = (facts: ILabelFacts) => void
export type LabelProgress = (progress: ILabelTaskResult) => void

export interface ILabelRunOptions {
  warehousePath: string
  // `labels update`: every task, another model's label counting as done; `labels run`: one task, only the run's own
  // model's labels done, with a sample or a limit.
  scope: { kind: 'update' } | { kind: 'run'; task: LabelTaskName; sample?: number; limit?: number }
  model?: string
  signal: AbortSignal
  // The preflight facts, after the lock is taken and before the first model call.
  onPreflight?: LabelPreflight
  onProgress?: LabelProgress
  concurrency?: number
  timeoutMs?: number
}

// The record's error for a stop, in the words the CLI prints.
const errorOf = (stop: ILabelTaskStop, model: string): string | null => {
  const detail = stop.detail ?? ''
  if (stop.outcome === 'limit') {
    return `Stopped at your Claude usage limit (${detail}).`
  }
  if (stop.outcome === 'unreachable') {
    return `Labelling stopped: Claude Code could not reach its API (${detail}).`
  }
  if (stop.outcome === 'stopped') {
    return null
  }
  if (stop.cause === 'authentication') {
    return `Claude Code is not signed in (${detail}).`
  }
  if (stop.cause === 'binary-missing') {
    return `Claude Code was not found (${detail}).`
  }
  if (stop.cause === 'no-result') {
    return `Labelling failed on ${model}: claude exited with code ${String(stop.exitCode)} and gave no result.`
  }
  return `Labelling failed on ${model}: ${detail}.`
}

const tasksOf = (scope: ILabelRunOptions['scope']): ILabelRunTask[] =>
  scope.kind === 'update' ? labelRunTasks() : labelRunTasks().filter((task) => task.name === scope.task)

const selectionOf = (scope: ILabelRunOptions['scope'], model: string): Omit<TPendingSelection, 'task'> =>
  scope.kind === 'update'
    ? { model, doneBy: 'any-model' }
    : {
        model,
        doneBy: 'own-model',
        ...(scope.sample === undefined ? {} : { sample: scope.sample }),
        ...(scope.limit === undefined ? {} : { limit: scope.limit }),
      }

const failureKindOf = (stop: ILabelTaskStop | null): ILabelRunReport['failureKind'] => {
  if (stop?.outcome !== 'failed') {
    return null
  }
  if (stop.cause === 'authentication') {
    return 'not-signed-in'
  }
  return stop.cause === 'binary-missing' ? 'not-found' : 'failure'
}

const reportOf = (results: readonly ILabelTaskResult[], model: string, startedAt: number): ILabelRunReport => {
  const stop = results.find((result) => result.stop !== null)?.stop ?? null
  const sum = (pick: (result: ILabelTaskResult) => number): number =>
    results.reduce((total, result) => total + pick(result), 0)
  const error = stop === null ? null : errorOf(stop, model)
  return {
    status: 'ran',
    outcome: stop?.outcome ?? 'ok',
    failureKind: failureKindOf(stop),
    tasks: results.map((result) => ({
      task: result.task,
      planned: result.planned,
      done: result.labelled,
      unanswered: result.unanswered,
    })),
    totals: {
      planned: sum((result) => result.planned),
      done: sum((result) => result.labelled),
      unanswered: sum((result) => result.unanswered),
      inputTokens: sum((result) => result.inputTokens),
      outputTokens: sum((result) => result.outputTokens),
    },
    error: error === null ? null : withHomeAsTilde(error, homedir()),
    durationMs: Date.now() - startedAt,
  }
}

interface ILabelSession {
  store: WarehouseStore
  runId: number
  tasks: readonly ILabelRunTask[]
  model: string
  selection: Omit<TPendingSelection, 'task'>
  options: ILabelRunOptions
  binary: string
}

// Each task in order, its pending list counted again as it starts; a stop in any task starts no later task, since a
// usage limit would hit the next one too.
const runTasks = async (session: ILabelSession, cwd: string): Promise<ILabelTaskResult[]> =>
  session.tasks.reduce<Promise<ILabelTaskResult[]>>(async (previous, task) => {
    const results = await previous
    if (results.some((result) => result.stop !== null) || session.options.signal.aborted) {
      return results
    }
    const { options } = session
    const result = await runLabelTask({
      store: session.store,
      runId: session.runId,
      task,
      ...session.selection,
      claude: {
        binary: session.binary,
        cwd,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      },
      signal: options.signal,
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    })
    return [...results, result]
  }, Promise.resolve([]))

// One labelling run, the same whether a terminal or the web app's Start began it. It holds the labelling lock so two
// runs never build the same pending list and pay twice, keeps the run record the web app reads its progress from, and
// ends every way it can with an outcome. It never asks anything: stopping keeps what is labelled.
export const runLabelling = async (options: ILabelRunOptions): Promise<LabelRunResult> => {
  const startedAt = Date.now()
  const model = labelModelOf(options.model)
  const detection = await detectClaude(options.signal)
  if (detection.status === 'missing') {
    return { status: 'missing', missing: detection.missing }
  }
  // A held lock ends it here with the holder, before the warehouse is opened, so it never meets SQLite's busy timeout.
  const lock = takeLabelsLock(options.warehousePath, 'labels')
  try {
    const store = await WarehouseStore.open(options.warehousePath)
    try {
      const tasks = tasksOf(options.scope)
      const selection = selectionOf(options.scope, model)
      const facts = buildLabelFacts(store, tasks, detection, selection)
      options.onPreflight?.(facts)
      const runId = store.startLabelRun({
        pid: process.pid,
        startedAt,
        model,
        tasks: facts.tasks.map(({ task, records }) => ({
          task,
          version: tasks.find((candidate) => candidate.name === task)?.version ?? 0,
          planned: records,
        })),
      })
      const session = { store, runId, tasks, model, selection, options, binary: detection.binary }
      const results = facts.records === 0 ? [] : await inLabelDirectory(async (cwd) => runTasks(session, cwd))
      const report = reportOf(results, model, startedAt)
      store.endLabelRun(runId, { endedAt: Date.now(), outcome: report.outcome, error: report.error })
      return report
    } finally {
      store.close()
    }
  } finally {
    lock.release()
  }
}
