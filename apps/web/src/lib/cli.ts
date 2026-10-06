import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { CliError } from './errors'

// The host's child registry, as the web app uses it: it starts `logbook <args>` and stops it with the host.
export interface IChildRegistry {
  spawn: (args: readonly string[]) => ChildProcess
}

// How a logbook child ended: its exit code (null when a signal ended it), its whole stdout and the last lines of its
// stderr, where it writes its progress and, last, its error.
export interface ICliRun {
  code: number | null
  stdout: string
  stderr: string[]
}

const CLI_VARIABLE = 'LOGBOOK_CLI'
const STDERR_LINES = 20

// The exit codes the web app acts on, from logbook's contract.
export const EXIT = { success: 0, alreadyRunning: 3, updatedWhileRunning: 9, partialFailure: 10 } as const

const UPDATED_WHILE_RUNNING = 'Log Book was updated while running. Press Ctrl+C and start logbook again.'

// The logbook entry script LOGBOOK_CLI names. The host sets it; under astro dev a developer does.
const entry = (): string => {
  const path = process.env[CLI_VARIABLE]
  if (path === undefined || path === '') {
    throw new CliError(
      `Set ${CLI_VARIABLE} to the logbook entry script to write from here. logbook sets it itself; this is only needed under astro dev.`
    )
  }
  if (!existsSync(path)) {
    throw new CliError(`No logbook entry at ${path} (the path in ${CLI_VARIABLE}).`)
  }
  return path
}

// The last STDERR_LINES lines of stderr, without the empty one after its final newline.
const tailOf = (stderr: string): string[] => stderr.replace(/\n$/u, '').split('\n').slice(-STDERR_LINES)

// Runs `logbook <args>` and waits for it: through the host's registry when the page has one, or as a child of this
// process under astro dev. Either way an argument array and no shell, this process's environment and directory, stdin
// ignored and never detached.
export const runLogbook = async (args: readonly string[], children?: IChildRegistry): Promise<ICliRun> => {
  const path = entry()
  const child =
    children === undefined
      ? spawn(process.execPath, [path, ...args], {
          env: process.env,
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          detached: false,
        })
      : children.spawn(args)
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code: number | null) => {
      resolve({ code, stdout, stderr: tailOf(stderr) })
    })
  })
}

// The error a failed command ends a write with: the update sentence for a logbook updated meanwhile, otherwise the
// command and its last non-empty stderr line.
export const failureOf = (command: string, run: ICliRun): CliError => {
  if (run.code === EXIT.updatedWhileRunning) {
    return new CliError(UPDATED_WHILE_RUNNING)
  }
  const last = run.stderr.findLast((text) => text.trim() !== '') ?? `exit ${String(run.code)}`
  return new CliError(`logbook ${command} failed: ${last}`)
}
