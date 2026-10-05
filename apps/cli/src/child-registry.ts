import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

// This module's own location, which the network allowlist test reads, so moving the file without its entry fails.
export const CHILD_REGISTRY_URL = import.meta.url

// The absolute path of the logbook entry every child runs; the host sets it in its own environment.
export const CLI_ENTRY_VARIABLE = 'LOGBOOK_CLI'

// How long a child has to end after SIGTERM before it gets SIGKILL.
export const KILL_AFTER_MS = 10_000

type TSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

// Every child of the host: the scheduler's syncs and every logbook the web app starts. The web app receives it in
// `locals` as `children` and calls only `spawn`; the host stops them all when it stops.
export interface IChildRegistry {
  // Starts `logbook <args>` and registers it until it ends.
  spawn: (args: readonly string[]) => ChildProcess
  // SIGTERM to every child, SIGKILL to those still alive after KILL_AFTER_MS; resolves once all have ended.
  stop: () => Promise<void>
  // SIGKILL to every child at once.
  kill: () => void
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
export const createChildRegistry = (env: NodeJS.ProcessEnv, start: TSpawn = spawn): IChildRegistry => {
  const children = new Map<ChildProcess, Promise<void>>()

  const killAll = (): void => {
    for (const child of children.keys()) {
      child.kill('SIGKILL')
    }
  }

  return {
    spawn: (args) => {
      const entry = env[CLI_ENTRY_VARIABLE]
      if (entry === undefined) {
        throw new Error(`${CLI_ENTRY_VARIABLE} is not set; the host sets it before it starts a child.`)
      }
      // An argument array and no shell; never detached, so a child cannot outlive the host.
      const child = start(process.execPath, [entry, ...args], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: false,
      })
      children.set(
        child,
        ended(child, () => children.delete(child))
      )
      return child
    },
    stop: async () => {
      const running = [...children]
      for (const [child] of running) {
        child.kill('SIGTERM')
      }
      const timer = setTimeout(killAll, KILL_AFTER_MS)
      await Promise.all(running.map(async ([, done]) => done))
      clearTimeout(timer)
    },
    kill: killAll,
  }
}
