import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { LogBookError } from '@log-book/core'
import { WAREHOUSE_ERROR_CODES } from './errors.js'

const DATA_DIRECTORY_NAME = 'log-book'
const WAREHOUSE_FILE_NAME = 'warehouse.db'

// $XDG_DATA_HOME/log-book when XDG_DATA_HOME is absolute; a relative or empty value is ignored, as the XDG Base
// Directory specification requires. LOGBOOK_DB never moves it.
export const resolveDataDirectory = (): string => {
  const xdgDataHome = process.env.XDG_DATA_HOME
  const dataHome =
    xdgDataHome !== undefined && isAbsolute(xdgDataHome) ? xdgDataHome : join(homedir(), '.local', 'share')
  return join(dataHome, DATA_DIRECTORY_NAME)
}

// LOGBOOK_DB names the warehouse file only, and is validated here once so no caller checks it again.
export const resolveWarehousePath = (): string => {
  const override = process.env.LOGBOOK_DB
  if (override === undefined || override === '') {
    return join(resolveDataDirectory(), WAREHOUSE_FILE_NAME)
  }
  if (!isAbsolute(override)) {
    throw new LogBookError(
      `LOGBOOK_DB must be an absolute path to the warehouse file; it is "${override}".`,
      WAREHOUSE_ERROR_CODES.WAREHOUSE_PATH_INVALID
    )
  }
  return override
}
