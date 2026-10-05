import { existsSync, statSync } from 'node:fs'
import type { IAdapterEnvironment, IHarnessAdapter } from '@log-book/adapter-api'
import { adapterEnvironment, createEngine, type ClaudeDetection } from '@log-book/engine'
import { resolveWarehousePath, SCHEMA_VERSION, WarehouseStore, WarehouseVersionError } from '@log-book/warehouse'
import { columnOf, discoverAdapters, discoveryLines } from './discovery.js'
import { exitCodeOf } from './errors.js'
import { formatSize, tildePath } from './format.js'
import { ADAPTERS } from './grammar.js'
import { hostFilePath, runningHost } from './host-file.js'
import { doctorLabellingLine } from './labelling-lines.js'
import type { CommandRunner } from './run-cli.js'

// What doctor looks at: the registered adapters, the environment they locate in, and the Claude Code detection.
export interface IDoctorSources {
  adapters: readonly IHarnessAdapter[]
  environment: () => IAdapterEnvironment
  detect: (signal: AbortSignal) => Promise<ClaudeDetection>
}

const DOCTOR_COLUMN = 12

const DEFAULT_SOURCES: IDoctorSources = {
  adapters: ADAPTERS,
  environment: adapterEnvironment,
  detect: async (signal) =>
    createEngine({ adapters: ADAPTERS, warehousePath: resolveWarehousePath() }).labels.detect({ signal }),
}

// The schema the file has, whatever it is: a version error is a report here, not a refusal.
const schemaOf = async (path: string): Promise<number> => {
  try {
    ;(await WarehouseStore.openReadOnly(path)).close()
    return SCHEMA_VERSION
  } catch (error: unknown) {
    if (error instanceof WarehouseVersionError) {
      return error.warehouseVersion
    }
    throw error
  }
}

// The warehouse file and its write-ahead log together.
const bytesOf = (path: string): number => {
  const wal = `${path}-wal`
  return statSync(path).size + (existsSync(wal) ? statSync(wal).size : 0)
}

// The warehouse as it is: never created, migrated or written; a missing one stays missing.
const warehouseText = async (path: string, home: string): Promise<string> => {
  const shown = tildePath(path, home)
  if (!existsSync(path)) {
    return `${shown} (not created yet)`
  }
  const host = await runningHost(hostFilePath(path))
  const hostText = host === null ? 'no host running' : `host running at http://127.0.0.1:${String(host.port)}`
  return `${shown} (schema ${String(await schemaOf(path))}, ${formatSize(bytesOf(path))}; ${hostText})`
}

// `logbook doctor`: the checks of the host's start, starting nothing and writing nothing, as one block to paste into
// an issue. It reports and does not judge, so it exits 0 whatever it finds.
export const createDoctorRunner =
  (sources: IDoctorSources = DEFAULT_SOURCES): CommandRunner =>
  async ({ io, version }) => {
    const env = sources.environment()
    const [warehouse, discovered, detection] = await Promise.all([
      warehouseText(resolveWarehousePath(), io.home),
      discoverAdapters(sources.adapters, env),
      sources.detect(io.signal),
    ])
    const lines = [
      `Log Book ${version}, Node.js ${process.versions.node}, ${process.platform} ${process.arch}`,
      columnOf('Warehouse', DOCTOR_COLUMN) + warehouse,
      ...discoveryLines(discovered, DOCTOR_COLUMN, env),
      doctorLabellingLine(detection, io.home),
    ]
    io.stdout(`${lines.join('\n')}\n`)
    return exitCodeOf('success')
  }
