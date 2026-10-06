import { LogBookError } from '@log-book/core'
import {
  resolveWarehousePath,
  SCHEMA_VERSION,
  WAREHOUSE_ERROR_CODES,
  WarehouseStore,
  WarehouseVersionError,
  type IWarehouseReader,
} from '@log-book/warehouse'

type TSqlParam = string | number | null

let reader: IWarehouseReader | undefined

// What keeps the app from reading the warehouse: no file at its path, or another schema version than this build reads.
export type TUnreadable = { kind: 'missing'; path: string } | { kind: 'version'; version: number }

const open = (): IWarehouseReader => {
  reader ??= WarehouseStore.openReadOnlySync(resolveWarehousePath())
  return reader
}

// Opened read-only once per process; a missing file and another version leave it closed, and the next page tries
// again. A newer logbook in a terminal can migrate the file while the app runs, so the version is read on every call
// (load makes one before a page reads anything).
export const unreadable = (): TUnreadable | null => {
  try {
    const version = open().get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0
    return version === SCHEMA_VERSION ? null : { kind: 'version', version }
  } catch (error) {
    if (error instanceof WarehouseVersionError) {
      return { kind: 'version', version: error.warehouseVersion }
    }
    if (error instanceof LogBookError && error.code === WAREHOUSE_ERROR_CODES.WAREHOUSE_NOT_FOUND) {
      return { kind: 'missing', path: resolveWarehousePath() }
    }
    throw error
  }
}

export const all = <TRow>(sql: string, ...params: TSqlParam[]): TRow[] => open().all<TRow>(sql, ...params)

export const get = <TRow>(sql: string, ...params: TSqlParam[]): TRow | undefined => open().get<TRow>(sql, ...params)

// Changes whenever another connection (a sync, a labelling run) commits to the warehouse, so a cache over its rows is
// current while this number stays the same.
export const dataVersion = (): number => get<{ version: number }>('PRAGMA data_version')?.version ?? 0
