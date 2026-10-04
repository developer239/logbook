import { LogBookError } from '@log-book/core'

export const WAREHOUSE_ERROR_CODES = {
  WAREHOUSE_PATH_INVALID: 'WAREHOUSE_PATH_INVALID',
  WAREHOUSE_NOT_FOUND: 'WAREHOUSE_NOT_FOUND',
  WAREHOUSE_SCHEMA_MISMATCH: 'WAREHOUSE_SCHEMA_MISMATCH',
  WAREHOUSE_SCHEMA_NEWER: 'WAREHOUSE_SCHEMA_NEWER',
  WAREHOUSE_LOCK_HELD: 'WAREHOUSE_LOCK_HELD',
  WAREHOUSE_LOCK_UNREADABLE: 'WAREHOUSE_LOCK_UNREADABLE',
} as const

// A warehouse at a version this build cannot open as asked. The words users read are the CLI's; the error carries
// the two versions as values.
export class WarehouseVersionError extends LogBookError {
  public readonly warehouseVersion: number
  public readonly buildVersion: number

  constructor(message: string, code: string, warehouseVersion: number, buildVersion: number) {
    super(message, code)
    this.warehouseVersion = warehouseVersion
    this.buildVersion = buildVersion
  }
}

// A lock another live process holds. The words users read are the CLI's; the error carries the holder.
export class WarehouseLockHeldError extends LogBookError {
  public readonly pid: number
  public readonly startedAt: number
  public readonly operation: string
  public readonly path: string

  constructor(message: string, holder: { pid: number; startedAt: number; operation: string; path: string }) {
    super(message, WAREHOUSE_ERROR_CODES.WAREHOUSE_LOCK_HELD)
    this.pid = holder.pid
    this.startedAt = holder.startedAt
    this.operation = holder.operation
    this.path = holder.path
  }
}
