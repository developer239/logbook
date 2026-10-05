import { LogBookError } from '@log-book/core'
import { resolveWarehousePath, WAREHOUSE_ERROR_CODES, WarehouseVersionError } from '@log-book/warehouse'
import { tildePath } from './format.js'
import { EXIT_CODES, PACKAGE, type ExitCodeName } from './grammar.js'

export interface IErrorReport {
  code: number
  // The last line of stderr.
  line: string
}

interface IErrorContext {
  // This Log Book's version.
  version: string
  home: string
}

export const exitCodeOf = (name: ExitCodeName): number => {
  const found = EXIT_CODES.find((exit) => exit.name === name)
  if (found === undefined) {
    throw new Error(`No exit code is named ${name}`)
  }
  return found.code
}

const versionReport = (error: WarehouseVersionError, context: IErrorContext): IErrorReport => {
  const schemas = `The warehouse is at schema ${String(error.warehouseVersion)}; this Log Book (${context.version}) reads schema ${String(error.buildVersion)}.`
  if (error.code === WAREHOUSE_ERROR_CODES.WAREHOUSE_SCHEMA_NEWER || error.warehouseVersion > error.buildVersion) {
    const latest = PACKAGE.distTags[0]
    return {
      code: exitCodeOf('newer warehouse'),
      line: `${schemas} Update with npm install -g ${PACKAGE.name}@${latest}.`,
    }
  }
  return {
    code: exitCodeOf('failure'),
    line: `${schemas} Run ${PACKAGE.binary} sync or start ${PACKAGE.binary} once to migrate it.`,
  }
}

// The exit code and the one line an error ends a command with. The warehouse errors carry their versions as values,
// so no message is read to find them.
export const errorReport = (error: unknown, context: IErrorContext): IErrorReport => {
  if (error instanceof WarehouseVersionError) {
    return versionReport(error, context)
  }
  if (error instanceof LogBookError && error.code === WAREHOUSE_ERROR_CODES.WAREHOUSE_NOT_FOUND) {
    const path = tildePath(resolveWarehousePath(), context.home)
    return {
      code: exitCodeOf('failure'),
      line: `No warehouse at ${path} yet. Run ${PACKAGE.binary} sync or start ${PACKAGE.binary} first.`,
    }
  }
  return { code: exitCodeOf('failure'), line: error instanceof Error ? error.message : String(error) }
}
