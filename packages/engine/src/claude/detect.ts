import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { inLabelDirectory, runClaude } from './claude-process.js'

// The Claude Code version the labelling flags were measured on. A minimum, so a newer one works until it changes a flag.
export const CLAUDE_MINIMUM_VERSION = '2.1.286'

const DETECTION_TIMEOUT_MS = 30_000
const VERSION_PATTERN = /(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u

export type ClaudeMissing =
  // `variable` is `CLAUDE_BIN` when it named no absolute path to an executable file, null when `PATH` holds none.
  | { readonly kind: 'not-found'; readonly variable: 'CLAUDE_BIN' | null }
  | { readonly kind: 'version-unreadable' }
  | { readonly kind: 'too-old'; readonly version: string; readonly minimum: string }
  | { readonly kind: 'not-signed-in' }

export type ClaudeDetection =
  | {
      readonly status: 'ready'
      readonly binary: string
      readonly version: string
      readonly authMethod: string | null
      readonly apiProvider: string | null
      // Claude Code may bill a print-mode run to this key instead of the user's plan; its value is never read.
      readonly hasApiKey: boolean
    }
  | { readonly status: 'missing'; readonly missing: ClaudeMissing }

type TBinary = { readonly path: string } | { readonly missing: ClaudeMissing }

const isExecutableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// `CLAUDE_BIN` when set and not empty, otherwise `claude` found by walking `PATH`: no shell, no `which`.
const findBinary = (): TBinary => {
  const named = process.env.CLAUDE_BIN ?? ''
  if (named !== '') {
    return isAbsolute(named) && isExecutableFile(named)
      ? { path: named }
      : { missing: { kind: 'not-found', variable: 'CLAUDE_BIN' } }
  }
  const found = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((directory) => directory !== '')
    .map((directory) => join(directory, 'claude'))
    .find((candidate) => isExecutableFile(candidate))
  return found === undefined ? { missing: { kind: 'not-found', variable: null } } : { path: found }
}

const partsOf = (match: RegExpExecArray): number[] =>
  [match.groups?.major, match.groups?.minor, match.groups?.patch].map(Number)

const isOlder = (version: RegExpExecArray, minimum: RegExpExecArray): boolean => {
  const [found, least] = [partsOf(version), partsOf(minimum)]
  const index = found.findIndex((part, position) => part !== least[position])
  return index !== -1 && (found[index] ?? 0) < (least[index] ?? 0)
}

// Only three fields of the login status are kept; every other one, the account's email and organisation among them,
// is dropped unread and never printed, logged or stored.
const loginOf = (stdout: string): { loggedIn: boolean; authMethod: string | null; apiProvider: string | null } => {
  let status: unknown = null
  try {
    status = JSON.parse(stdout)
  } catch {
    status = null
  }
  const field = (name: string): unknown =>
    typeof status === 'object' && status !== null ? (status as Record<string, unknown>)[name] : undefined
  const text = (name: string): string | null => {
    const value = field(name)
    return typeof value === 'string' ? value : null
  }
  return { loggedIn: field('loggedIn') === true, authMethod: text('authMethod'), apiProvider: text('apiProvider') }
}

// Checks, before any labelling, that the user's Claude Code is there, new enough and signed in. Neither command it
// runs calls a model or opens a connection, so it costs no tokens and sends nothing. No other model stands in when a
// check fails.
export const detectClaude = async (signal?: AbortSignal): Promise<ClaudeDetection> => {
  const binary = findBinary()
  if ('missing' in binary) {
    return { status: 'missing', missing: binary.missing }
  }
  return inLabelDirectory(async (cwd) => {
    const run = async (args: string[]): Promise<string> =>
      (
        await runClaude({
          binary: binary.path,
          args,
          cwd,
          timeoutMs: DETECTION_TIMEOUT_MS,
          ...(signal === undefined ? {} : { signal }),
        })
      ).stdout
    const version = VERSION_PATTERN.exec(await run(['--version']))
    const minimum = VERSION_PATTERN.exec(CLAUDE_MINIMUM_VERSION)
    if (version === null || minimum === null) {
      return { status: 'missing', missing: { kind: 'version-unreadable' } }
    }
    if (isOlder(version, minimum)) {
      return { status: 'missing', missing: { kind: 'too-old', version: version[0], minimum: CLAUDE_MINIMUM_VERSION } }
    }
    const login = loginOf(await run(['auth', 'status', '--json']))
    if (!login.loggedIn) {
      return { status: 'missing', missing: { kind: 'not-signed-in' } }
    }
    return {
      status: 'ready',
      binary: binary.path,
      version: version[0],
      authMethod: login.authMethod,
      apiProvider: login.apiProvider,
      hasApiKey: (process.env.ANTHROPIC_API_KEY ?? '') !== '',
    }
  })
}
