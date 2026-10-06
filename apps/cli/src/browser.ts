import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

// This module's own location, which the network allowlist test reads, so moving the file without its entry fails.
export const BROWSER_URL = import.meta.url

// `Browser` and the host's column.
const BROWSER_COLUMN = 'Browser      '

// Where the opener is looked for and on which platform; each is replaced in tests.
interface IOpenerSources {
  platform: NodeJS.Platform
  path: string | undefined
}

const DEFAULT_SOURCES: IOpenerSources = { platform: process.platform, path: process.env.PATH }

// The user's program that opens a URL in their default browser: `open` on macOS, `xdg-open` on Linux.
export const openerName = (platform: NodeJS.Platform): string => (platform === 'darwin' ? 'open' : 'xdg-open')

const isExecutableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// The first executable file of that name on PATH, as a shell would find it; null when there is none.
export const findOnPath = (name: string, path: string | undefined): string | null =>
  (path ?? '')
    .split(delimiter)
    .filter((directory) => directory !== '')
    .map((directory) => join(directory, name))
    .find(isExecutableFile) ?? null

const notOpened = (reason: string, url: string): string =>
  `${BROWSER_COLUMN}not opened: ${reason}. Open ${url} yourself, or start with logbook --no-open.`

// Opens the URL in the user's browser. The opener is the user's program, so it starts outside the host's process group
// (detached, so a browser it starts survives Ctrl+C) and is never waited for or signalled; only its exit is listened
// for, to report a failure in one line. Success says nothing. Returns the opener it started, or null.
export const openBrowser = (
  url: string,
  report: (line: string) => void,
  sources = DEFAULT_SOURCES
): ChildProcess | null => {
  const name = openerName(sources.platform)
  const opener = findOnPath(name, sources.path)

  if (opener === null) {
    report(notOpened(`no ${name} on this machine`, url))
    return null
  }

  const child = spawn(opener, [url], { stdio: 'ignore', shell: false, detached: true })
  child.once('error', (error: NodeJS.ErrnoException) => {
    report(notOpened(`${name} could not be started (${error.code ?? error.message})`, url))
  })
  child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    if (code !== 0) {
      report(
        notOpened(
          code === null ? `${name} was ended by ${String(signal)}` : `${name} exited with code ${String(code)}`,
          url
        )
      )
    }
  })
  child.unref()
  return child
}
