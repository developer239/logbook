import type { IHarnessAdapter } from '@log-book/adapter-api'
import { checkRegistrations } from './registration.js'

export interface IEngineOptions {
  // The registered adapters, as values; the engine loops over them and never names a harness.
  readonly adapters: readonly IHarnessAdapter[]
  readonly warehousePath: string
  readonly onProgress?: (line: string) => void
}

// The engine's operations; later tickets add sync, read, labels, forget and compact.
export interface IEngine {
  readonly adapters: readonly IHarnessAdapter[]
  readonly warehousePath: string
}

// The one entry point of @log-book/engine. It does no I/O: it checks the adapter list before anything runs and returns
// the engine.
export const createEngine = (options: IEngineOptions): IEngine => {
  checkRegistrations(options.adapters)
  return { adapters: options.adapters, warehousePath: options.warehousePath }
}
