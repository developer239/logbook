import assert from 'node:assert/strict'
import { openSqlite } from '@log-book/core'
import type {
  IAdapterContext,
  IAdapterEnvironment,
  IHarnessAdapter,
  IHarnessLocation,
  IImportedUnit,
  ISourceReader,
  ISourceUnit,
} from '../contract.js'

export const adapterContext = (signal: AbortSignal = new AbortController().signal): IAdapterContext => ({
  signal,
  onProgress: () => undefined,
  openSqlite,
})

export const locateFound = async (adapter: IHarnessAdapter, env: IAdapterEnvironment): Promise<IHarnessLocation> => {
  const result = await adapter.locate(env)
  assert.equal(result.kind, 'found', `locate answered ${JSON.stringify(result)}`)
  return result.location
}

// Opens the source and closes it however the work ends, as the engine does.
export const withReader = async <TResult>(
  adapter: IHarnessAdapter,
  location: IHarnessLocation,
  work: (reader: ISourceReader) => Promise<TResult>
): Promise<TResult> => {
  const reader = await adapter.openSource(location, adapterContext())
  try {
    return await work(reader)
  } finally {
    await reader.close()
  }
}

export interface IListedImport {
  unit: ISourceUnit
  imported: IImportedUnit
}

export const importEvery = async (reader: ISourceReader): Promise<IListedImport[]> => {
  const units = await reader.listUnits()
  return Promise.all(units.map(async (unit) => ({ unit, imported: await reader.importUnit(unit) })))
}

// Locates the harness in the home, then lists and imports every unit through one reader.
export const importHome = async (adapter: IHarnessAdapter, env: IAdapterEnvironment): Promise<IListedImport[]> =>
  withReader(adapter, await locateFound(adapter, env), importEvery)
