import type { IHarnessAdapter } from '@log-book/adapter-api'
import { runCompact, type CompactProgress, type ICompactResult } from './compact/compact.js'
import { readOperations, type IReadOperations } from './read/read.js'
import { checkRegistrations } from './registration.js'
import { runSync, type ISyncResult, type SyncProgress } from './sync/sync.js'

export interface IEngineOptions {
  // The registered adapters, as values; the engine loops over them and never names a harness.
  readonly adapters: readonly IHarnessAdapter[]
  readonly warehousePath: string
  readonly onProgress?: (progress: SyncProgress) => void
}

// The engine's operations; later tickets add labels and forget.
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
  }
}
