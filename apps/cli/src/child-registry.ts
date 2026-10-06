import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { ISyncLogs } from './sync-logs.js'

// This module's own location, which the network allowlist test reads, so moving the file without its entry fails.
export const CHILD_REGISTRY_URL = import.meta.url

// The absolute path of the logbook entry every child runs; the host sets it in its own environment.
export const CLI_ENTRY_VARIABLE = 'LOGBOOK_CLI'

// How long a child has to end after SIGTERM before it gets SIGKILL.
export const KILL_AFTER_MS = 10_000

type TSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

interface ISpawnOptions {
  // An IPC channel beside stdout and stderr, which a sync reports its progress on.
  hasChannel?: boolean
}

// Every child of the host: the scheduler's syncs and every logbook the web app starts. The web app receives it in
// `locals` as `children` and calls only `spawn`; the host stops them all when it stops.
export interface IChildRegistry {
  // Starts `logbook <args>` and registers it until it ends.
  spawn: (args: readonly string[], options?: ISpawnOptions) => ChildProcess
  // The log a sync child's stderr goes to, or null for another child.
  logOf: (child: ChildProcess) => string | null
  // SIGTERM to one child, SIGKILL when it is still alive after KILL_AFTER_MS; resolves once it has ended.
  terminate: (child: ChildProcess) => Promise<void>
  // `terminate` for every child at once; resolves once all have ended.
  stop: () => Promise<void>
  // SIGKILL to every child at once.
  kill: () => void
}

export interface IChildRegistryOptions {
  start?: TSpawn
  // Where a sync child's full stderr is written; none in tests that do not read it.
  syncLogs?: ISyncLogs
}

interface IRegistered {
  ended: Promise<void>
  log: string | null
}

// Resolves when the child has ended, after `onEnd` ran.
const ended = async (child: ChildProcess, onEnd: () => void): Promise<void> =>
  new Promise((resolve) => {
    const end = (): void => {
      onEnd()
      resolve()
    }
    child.once('exit', end)
    child.once('error', end)
  })

// `env` is the host's own environment, read at each start, so a child inherits LOGBOOK_CLI and LOGBOOK_HOST_VERSION.
export const createChildRegistry = (
  env: NodeJS.ProcessEnv,
  { start = spawn, syncLogs }: IChildRegistryOptions = {}
): IChildRegistry => {
  const children = new Map<ChildProcess, IRegistered>()

  const terminate = async (child: ChildProcess): Promise<void> => {
    const registered = children.get(child)
    if (registered === undefined) {
      return
    }
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS)
    await registered.ended
    clearTimeout(timer)
  }

  return {
    spawn: (args, { hasChannel = false } = {}) => {
      const entry = env[CLI_ENTRY_VARIABLE]
      if (entry === undefined) {
        throw new Error(`${CLI_ENTRY_VARIABLE} is not set; the host sets it before it starts a child.`)
      }
      // An argument array and no shell; never detached, so a child cannot outlive the host.
      const child = start(process.execPath, [entry, ...args], {
        env,
        stdio: hasChannel ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: false,
      })
      const log = args[0] === 'sync' && syncLogs !== undefined ? syncLogs.open() : null
      if (log !== null) {
        child.stderr?.pipe(log.stream)
      }
      children.set(child, {
        log: log?.path ?? null,
        ended: ended(child, () => {
          children.delete(child)
          if (log !== null) {
            syncLogs?.prune()
          }
        }),
      })
      return child
    },
    logOf: (child) => children.get(child)?.log ?? null,
    terminate,
    stop: async () => {
      await Promise.all([...children.keys()].map(terminate))
    },
    kill: () => {
      for (const child of children.keys()) {
        child.kill('SIGKILL')
      }
    },
  }
}
