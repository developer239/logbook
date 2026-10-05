import { LogBookError } from '@log-book/core'
import {
  resolveWarehousePath,
  SCHEMA_VERSION,
  WAREHOUSE_ERROR_CODES,
  WarehouseStore,
  WarehouseVersionError,
  type IWarehouseReader,
} from '@log-book/warehouse'
import { WarehouseError } from './errors'

type TSqlParam = string | number | null

let reader: IWarehouseReader | undefined

const versionProblem = (version: number): WarehouseError =>
  new WarehouseError(`This warehouse is at schema ${String(version)}; this Log Book reads ${String(SCHEMA_VERSION)}.`)

// Opened read-only once per process; a missing file and another version are a page's problem line, and the next
// page tries again.
const open = (): IWarehouseReader => {
  const path = resolveWarehousePath()
  try {
    return WarehouseStore.openReadOnlySync(path)
  } catch (error) {
    if (error instanceof WarehouseVersionError) {
      throw versionProblem(error.warehouseVersion)
    }
    if (error instanceof LogBookError && error.code === WAREHOUSE_ERROR_CODES.WAREHOUSE_NOT_FOUND) {
      throw new WarehouseError(`There is no warehouse at ${path} yet.`)
    }
    throw error
  }
}

const warehouse = (): IWarehouseReader => {
  reader ??= open()
  return reader
}

// A newer logbook in a terminal can migrate the warehouse while the app runs, so a page checks its schema once
// before it reads anything (load does).
export const checkSchema = (): void => {
  const version = warehouse().get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0
  if (version !== SCHEMA_VERSION) {
    throw versionProblem(version)
  }
}

export const all = <TRow>(sql: string, ...params: TSqlParam[]): TRow[] => warehouse().all<TRow>(sql, ...params)

export const get = <TRow>(sql: string, ...params: TSqlParam[]): TRow | undefined =>
  warehouse().get<TRow>(sql, ...params)

export const syncedAt = (): number | null =>
  get<{ at: number | null }>('SELECT MAX(imported_at) AS at FROM source_state')?.at ?? null
