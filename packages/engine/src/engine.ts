import type { IHarnessAdapter } from '@log-book/adapter-api'
import { detectClaude, type ClaudeDetection } from './claude/detect.js'
import { compareLabellers } from './labels/compare.js'
import { dropLabels } from './labels/drop.js'
import { runLabelling, type LabelPreflight, type LabelProgress, type LabelRunResult } from './labels/label-run.js'
import { planLabelling, type LabelPlan } from './labels/plan.js'
import { previewLabelling, type ILabelPreview } from './labels/preview.js'
import type { LabelTaskName } from './labels/tasks.js'
import { readOperations, type IReadOperations } from './read/read.js'
import { checkRegistrations } from './registration.js'
import { runCompact, type CompactProgress, type ICompactResult } from './rewrite/compact.js'
import { runForget, type ForgetProgress, type ForgetTarget, type IForgetSessionsResult } from './rewrite/forget.js'
import { runSync, type ISyncResult, type SyncProgress } from './sync/sync.js'

export interface IEngineOptions {
  // The registered adapters, as values; the engine loops over them and never names a harness.
  readonly adapters: readonly IHarnessAdapter[]
  readonly warehousePath: string
  readonly onProgress?: (progress: SyncProgress) => void
}

export interface ILabelCallOptions {
  model?: string
  signal: AbortSignal
  onPreflight?: LabelPreflight
  onProgress?: LabelProgress
}

// The engine's operations; later tickets add labelling itself.
export interface IEngine {
  readonly adapters: readonly IHarnessAdapter[]
  readonly warehousePath: string
  readonly sync: (options: { signal: AbortSignal }) => Promise<ISyncResult>
  readonly read: IReadOperations
  // Gives back the disk space syncs leave free inside the warehouse, under both locks.
  readonly compact: (options: {
    signal: AbortSignal
    onProgress?: (progress: CompactProgress) => void
  }) => Promise<ICompactResult>
  // Removes everything held about some sessions and their subagents, keeps their ids from a later sync, and purges
  // their text from the file, under both locks.
  readonly forget: (
    options: ForgetTarget & { signal: AbortSignal; onProgress?: (progress: ForgetProgress) => void }
  ) => Promise<IForgetSessionsResult>
  readonly labels: {
    // Whether the user's Claude Code is there, new enough and signed in; the host and the doctor run it on its own.
    readonly detect: (options?: { signal?: AbortSignal }) => Promise<ClaudeDetection>
    // What a run would send now, taking no lock, writing nothing and starting no `claude -p`.
    readonly plan: (options?: { model?: string; signal?: AbortSignal }) => Promise<LabelPlan>
    // The next batches of a task exactly as a run would send them now, without running `claude`.
    readonly preview: (options: { task: LabelTaskName; batches?: number }) => Promise<ILabelPreview>
    // How often two labellers agree on a task's records both labelled, field by field, as markdown.
    readonly compare: (options: { task: string; first: string; second: string }) => Promise<string>
    // Deletes one model's labels of one task under the labelling lock; the records whose labels went.
    readonly drop: (options: { task: string; labeller: string }) => Promise<number>
    // Every task in order, under the labelling lock, with its run record.
    readonly update: (options: ILabelCallOptions) => Promise<LabelRunResult>
    // One task, only the run's own model's labels counting as done, with a sample or a limit.
    readonly run: (
      options: ILabelCallOptions & { task: LabelTaskName; sample?: number; limit?: number }
    ) => Promise<LabelRunResult>
  }
}

// The one entry point of @log-book/engine. It does no I/O: it checks the adapter list before anything runs and returns
// the engine.
export const createEngine = (options: IEngineOptions): IEngine => {
  checkRegistrations(options.adapters)
  const { adapters, warehousePath } = options
  const onProgress = options.onProgress ?? (() => undefined)
  return {
    adapters,
    warehousePath,
    sync: async ({ signal }) => runSync({ adapters, warehousePath, onProgress, signal }),
    read: readOperations(warehousePath),
    compact: async ({ signal, onProgress: onCompactProgress = () => undefined }) =>
      runCompact({ warehousePath, signal, onProgress: onCompactProgress }),
    forget: async ({ signal, onProgress: onForgetProgress = () => undefined, ...target }) =>
      runForget({ warehousePath, target, signal, onProgress: onForgetProgress }),
    labels: {
      detect: async (options = {}) => detectClaude(options.signal),
      plan: async (options = {}) => planLabelling({ ...options, warehousePath }),
      preview: async (options) => previewLabelling({ ...options, warehousePath }),
      compare: async (options) => compareLabellers({ ...options, warehousePath }),
      drop: async (options) => dropLabels({ ...options, warehousePath }),
      update: async (options) => runLabelling({ ...options, warehousePath, scope: { kind: 'update' } }),
      run: async ({ task, sample, limit, ...options }) =>
        runLabelling({
          ...options,
          warehousePath,
          scope: {
            kind: 'run',
            task,
            ...(sample === undefined ? {} : { sample }),
            ...(limit === undefined ? {} : { limit }),
          },
        }),
    },
  }
}
