import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IAdapterEnvironment } from '@log-book/adapter-api'
import { adapterEnvironment, createEngine, type ClaudeDetection } from '@log-book/engine'
import { resolveDataDirectory, resolveWarehousePath, WarehouseStore } from '@log-book/warehouse'
import { CLI_ENTRY_VARIABLE, createChildRegistry, type IChildRegistry } from './child-registry.js'
import { discoverAdapters, discoveryLines, warehouseLine } from './discovery.js'
import { errorReport, exitCodeOf } from './errors.js'
import { ADAPTERS } from './grammar.js'
import { closeServer, createRequestListener, HOST_ADDRESS, listen, portOf, type IWebApp } from './host-server.js'
import { hostLabellingLine } from './labelling-lines.js'
import { requiredIntegerOf } from './option-values.js'
import type { CommandRunner } from './run-cli.js'

const HOST_COLUMN = 13
const HOST_VERSION_VARIABLE = 'LOGBOOK_HOST_VERSION'

// The entry a child of the host runs: the binary the user runs, beside this module's build.
const CLI_ENTRY = fileURLToPath(new URL('../bin/logbook.cjs', import.meta.url))

interface IHostPaths {
  warehousePath: string
  dataDirectory: string
}

interface IOpenedWarehouse {
  path: string
  previousVersion: number
  version: number
}

// A host that is serving: how to stop it, and how to stop it at once.
export interface IServing {
  stop: () => Promise<void>
  kill: () => void
}

// The steps of the start this command owns, by their number in the start sequence. The one-host check (3), the host
// file (7), opening the browser (8), the first sync (10) and the schedule (11) take their places between them.
export interface IStartSteps {
  // 2: the paths, before anything opens the warehouse.
  resolvePaths: () => IHostPaths
  // 4: create or migrate the warehouse, and close it.
  migrate: (paths: IHostPaths) => Promise<IOpenedWarehouse>
  // 5: the version, the warehouse line and the discovery lines.
  announce: (opened: IOpenedWarehouse) => Promise<void>
  // 6: the children's environment, the server on 127.0.0.1 and the URL.
  serve: () => Promise<IServing>
  // 9: labelling detection, in the background; it never delays the URL.
  detect: () => void
}

export const startHost = async (steps: IStartSteps): Promise<IServing> => {
  const paths = steps.resolvePaths()
  const opened = await steps.migrate(paths)
  await steps.announce(opened)
  const serving = await steps.serve()
  steps.detect()
  return serving
}

// Calls the listener on every stop signal until the returned function is called.
export type StopSignals = (listener: () => void) => () => void

// The first stop signal stops the host and its children; a second one while it stops kills the children and ends
// at once. Either way the host exits 0: stopping is how it ends.
export const waitForStop = async (serving: IServing, signals: StopSignals): Promise<number> =>
  new Promise((resolveCode) => {
    let isStopping = false
    const end = (): void => {
      unsubscribe()
      resolveCode(exitCodeOf('success'))
    }
    const stop = async (): Promise<void> => {
      await serving.stop()
      end()
    }
    const unsubscribe = signals(() => {
      if (isStopping) {
        serving.kill()
        end()
        return
      }
      isStopping = true
      void stop()
    })
  })

// What the host reads from outside itself; each is replaced in tests.
export interface IHostSources {
  environment: () => IAdapterEnvironment
  loadWebApp: () => Promise<IWebApp>
  detect: (signal: AbortSignal) => Promise<ClaudeDetection>
  createRegistry: (env: NodeJS.ProcessEnv) => IChildRegistry
  signals: StopSignals
}

// The web app's build, loaded when the host starts, so no other command pays for it.
const loadWebApp = async (): Promise<IWebApp> => {
  const [{ handler }, guard] = await Promise.all([import('@log-book/web'), import('@log-book/web/guard')])
  const serverEntry = fileURLToPath(import.meta.resolve('@log-book/web'))
  return { guard, handler, clientDirectory: join(dirname(serverEntry), '..', 'client') }
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

const processSignals: StopSignals = (listener) => {
  for (const signal of STOP_SIGNALS) {
    process.on(signal, listener)
  }
  return () => {
    for (const signal of STOP_SIGNALS) {
      process.off(signal, listener)
    }
  }
}

const DEFAULT_SOURCES: IHostSources = {
  environment: adapterEnvironment,
  loadWebApp,
  detect: async (signal) =>
    createEngine({ adapters: ADAPTERS, warehousePath: resolveWarehousePath() }).labels.detect({ signal }),
  createRegistry: (env) => createChildRegistry(env),
  signals: processSignals,
}

const line = (text: string): string => `${text}\n`

// `logbook` and `logbook start`: migrate the warehouse, say what was found, serve the web app on 127.0.0.1 and own
// every child process until a stop signal.
export const createHostRunner =
  (sources: IHostSources = DEFAULT_SOURCES): CommandRunner =>
  async ({ io, values, version }) => {
    const detection = new AbortController()
    const report = (error: unknown): void => {
      io.stderr(line(errorReport(error, { version, home: io.home, command: 'start' }).line))
    }
    // A stop aborts detection; that is no failure to report.
    const announceDetection = async (): Promise<void> => {
      try {
        io.stdout(line(hostLabellingLine(await sources.detect(detection.signal))))
      } catch (error: unknown) {
        if (!detection.signal.aborted) {
          report(error)
        }
      }
    }
    const serving = await startHost({
      resolvePaths: () => ({ warehousePath: resolveWarehousePath(), dataDirectory: resolveDataDirectory() }),
      migrate: async ({ warehousePath }) => {
        const store = await WarehouseStore.open(warehousePath)
        store.close()
        return { path: warehousePath, previousVersion: store.previousVersion, version: store.version }
      },
      announce: async (opened) => {
        const env = sources.environment()
        const discovered = await discoverAdapters(ADAPTERS, env)
        const lines = [
          `Log Book ${version}`,
          warehouseLine(opened, HOST_COLUMN, io.home),
          ...discoveryLines(discovered, HOST_COLUMN, env),
        ]
        io.stdout(line(lines.join('\n')))
      },
      serve: async () => {
        // In the host's own environment, so every child inherits both, those the web app starts included.
        process.env[CLI_ENTRY_VARIABLE] = CLI_ENTRY
        process.env[HOST_VERSION_VARIABLE] = version
        const children = sources.createRegistry(process.env)
        const app = await sources.loadWebApp()
        const server = await listen(
          createRequestListener(app, version, { children }, report),
          requiredIntegerOf(values, 'port')
        )
        io.stdout(
          `\nLog Book is running at http://${HOST_ADDRESS}:${String(portOf(server))}\nPress Ctrl+C to stop.\n\n`
        )
        return {
          stop: async () => {
            detection.abort()
            await Promise.all([children.stop(), closeServer(server)])
          },
          kill: () => {
            detection.abort()
            children.kill()
          },
        }
      },
      detect: () => {
        void announceDetection()
      },
    })
    return waitForStop(serving, sources.signals)
  }
