import type { IHarnessAdapter } from '@log-book/adapter-api'
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

// The engine's operations; later tickets add labels.
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
  }
}
