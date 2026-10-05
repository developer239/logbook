import { isAbsolute, join, relative } from 'node:path'
import type { IImportedSession } from '@log-book/warehouse'
import type { TOOL_FAMILIES } from '../tool-families.js'

// The inverse of an adapter's reader: given invented, harness-neutral scripts, it writes the files its harness would
// have written and returns the records the adapter will import from them. Every writer guarantees:
// 1. It writes only below `home`, at the places its adapter's locate and prepareCommands resolve for
//    `{ homeDir: home, variables: {}, cwd: home }` (project command files below projectDirIn(home, projectDir)), and
//    returns every file it wrote.
// 2. No record holds `home`; every path in a record comes from the script.
// 3. Equal scripts give equal `expected`, `ids` and `files`, equal bytes for every text file and equal rows for a
//    database, on any machine: no clock, randomness, environment, time zone or locale. Times are written as epoch
//    milliseconds or ISO 8601 in UTC.
// 4. `expected` is computed from the scripts by the adapter's rules, never by calling importUnit or the adapter's
//    parsing code. A writer may share the adapter's value tables and helpers.
// 5. Ids are numbered from 1 per kind in writing order (scripts in array order, steps in order, a spawned session
//    right after its spawn step), in a `demo` shape distinct from hand-written fixture ids.
// 6. Every record it writes has a hand-written exemplar of the same shape in its adapter's fixture set.
// 7. It refuses a script it cannot record faithfully; it never drops a field, moves a time or substitutes a shape.
export interface ISourceWriter {
  readonly capabilities: ReadonlySet<SourceCapability>
  readonly families: ReadonlySet<ScriptFamily>
  // Returns every file written, relative to the home.
  writeCommandFiles: (home: string, files: readonly ICommandFile[]) => Promise<readonly string[]>
  // One call per home.
  writeSessions: (home: string, scripts: readonly ISessionScript[]) => Promise<IWrittenSource>
}

export interface IWrittenSource {
  // What importUnit will return: every session of every unit.
  readonly expected: readonly IImportedSession[]
  // Script key to the id of the record it became.
  readonly ids: ReadonlyMap<string, string>
  // Every file written, relative to the home.
  readonly files: readonly string[]
}

export interface ICommandFile {
  readonly name: string
  readonly body: string
  // A script's project directory, such as /home/example/work/shop; null for the global command directory.
  readonly projectDir: string | null
}

// The home the scripts were recorded in: the invented home of every fixture and of the demo.
export const SCRIPT_HOME = '/home/example'

// Where a script's project directory sits in the home a writer is given: `/home/example/work/shop` written into
// `/tmp/rt-1` is `/tmp/rt-1/work/shop`. It places files only; records keep the script's value.
export const projectDirIn = (home: string, projectDir: string): string => join(home, relative(SCRIPT_HOME, projectDir))

// True when the path is absolute, strictly below SCRIPT_HOME, with no `.` or `..` segment and no trailing `/`.
export const isScriptProjectDir = (path: string): boolean => {
  const segments = path.slice(SCRIPT_HOME.length + 1).split('/')
  return (
    isAbsolute(path) &&
    path.startsWith(`${SCRIPT_HOME}/`) &&
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  )
}

// The features a writer may lack. Always available: prompts, replies with text, reasoning and tokens, calls of the
// writer's families, spawns, skills, compaction and failed-request events, titles and the harness version.
export const SOURCE_CAPABILITIES = [
  'git-branch',
  'session-agent',
  'scripted',
  'image',
  'reported-cost',
  'mcp-server',
  // A command recorded by its name.
  'typed-command',
  // A command recorded as its file's body with the arguments in place.
  'template-command',
  'nested-subagent',
  'model-switch',
  'agent-switch',
  'idle-event',
  'tools-offered',
  'tools-loaded',
  'interrupt',
  // A call with status `rejected`.
  'tool-reject',
] as const
export type SourceCapability = (typeof SOURCE_CAPABILITIES)[number]

// A tool family other than subagent and skill, which the spawn and skill steps write, with `mcp` standing for
// `mcp:<server>` of the call's server.
export type ScriptFamily = Exclude<(typeof TOOL_FAMILIES)[number], 'subagent' | 'skill'> | 'mcp'

export interface IScriptTokens {
  readonly input: number | null
  readonly output: number | null
  readonly reasoning: number | null
  readonly cacheRead: number | null
  readonly cacheWrite: number | null
}

export type ScriptEvent =
  | { readonly type: 'compaction'; readonly summary: string }
  | { readonly type: 'failed-request'; readonly error: string }
  | { readonly type: 'model-switch'; readonly model: string; readonly previous: string }
  | { readonly type: 'agent-switch'; readonly agent: string }
  | { readonly type: 'idle'; readonly outcome: string }
  | {
      readonly type: 'tools-offered'
      readonly added: readonly string[]
      readonly removed: readonly string[]
      readonly failedServers: readonly { readonly name: string; readonly error: string }[]
    }
  | {
      readonly type: 'tools-loaded'
      readonly tools: readonly { readonly name: string; readonly description: string; readonly inputSchema: unknown }[]
    }

export type ScriptCallStatus = 'completed' | 'error' | 'pending' | 'rejected'

// A script states what happened, never how a harness records it: no tool names except where no harness name exists
// (`tool` for `mcp` and `other`, or to pick one row of an adapter's own table in its own fixture scripts), no harness
// input keys, no ids. Times are epoch milliseconds.
export type ScriptStep =
  | {
      readonly kind: 'prompt'
      readonly key: string
      readonly at: number
      readonly text: string
      readonly images: number
    }
  | {
      readonly kind: 'reply'
      readonly key: string
      readonly at: number
      readonly endAt: number
      readonly model: string
      readonly text: string | null
      readonly reasoning: string | null
      readonly tokens: IScriptTokens | null
      readonly cost: number | null
    }
  | {
      readonly kind: 'call'
      readonly key: string
      readonly family: ScriptFamily
      readonly intent: string | null
      readonly tool: string | null
      readonly server: string | null
      readonly input: Readonly<Record<string, unknown>>
      readonly status: ScriptCallStatus
      readonly result: string | null
      readonly startAt: number
      readonly endAt: number | null
    }
  | {
      readonly kind: 'spawn'
      readonly key: string
      readonly agentType: string
      readonly prompt: string
      readonly child: ISessionScript
      readonly result: string
      readonly startAt: number
      readonly endAt: number
    }
  | {
      readonly kind: 'skill'
      readonly key: string
      readonly name: string
      readonly text: string
      readonly startAt: number
      readonly endAt: number
    }
  | {
      readonly kind: 'command'
      readonly key: string
      readonly at: number
      readonly name: string
      readonly arguments: string
      readonly body: string | null
    }
  | { readonly kind: 'event'; readonly key: string; readonly at: number; readonly event: ScriptEvent }
  | { readonly kind: 'interrupt'; readonly key: string; readonly at: number }

export interface ISessionScript {
  readonly key: string
  // As recorded: absolute, invented and strictly below SCRIPT_HOME, such as /home/example/work/shop.
  readonly projectDir: string
  readonly title: string | null
  // A top-level session's agent: needs `session-agent`.
  readonly agent: string | null
  // Needs `git-branch`.
  readonly gitBranch: string | null
  // True needs `scripted`.
  readonly isScripted: boolean
  // Null: the writer's version for its newest tested version.
  readonly harnessVersion: string | null
  readonly steps: readonly ScriptStep[]
}

export const SOURCE_WRITER_ERROR_CODES = {
  // A field, step, event or family outside the writer's capabilities and families, or a script its harness would
  // record so that it imports differently.
  WRITER_SCRIPT_UNSUPPORTED: 'WRITER_SCRIPT_UNSUPPORTED',
  // A broken script rule, or a harnessVersion whose major.minor is not one of the adapter's testedVersions.
  WRITER_SCRIPT_INVALID: 'WRITER_SCRIPT_INVALID',
  // A file the writer would write exists.
  WRITER_TARGET_EXISTS: 'WRITER_TARGET_EXISTS',
} as const
