import { LogBookError } from '@log-book/core'

export const WAREHOUSE_ERROR_CODES = {
  WAREHOUSE_PATH_INVALID: 'WAREHOUSE_PATH_INVALID',
  WAREHOUSE_NOT_FOUND: 'WAREHOUSE_NOT_FOUND',
  WAREHOUSE_SCHEMA_MISMATCH: 'WAREHOUSE_SCHEMA_MISMATCH',
  WAREHOUSE_SCHEMA_NEWER: 'WAREHOUSE_SCHEMA_NEWER',
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
