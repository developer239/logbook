import type { openSqlite } from '@log-book/core'
import type { IImportedSession } from '@log-book/warehouse'

// What the engine and the people using Log Book know a harness by.
export interface IHarnessDescriptor {
  // kebab-case, unique among registered adapters, and the prefix of every session id the adapter produces.
  readonly id: string
  // Shown to people.
  readonly name: string
  // Shown when a session names no agent.
  readonly defaultAgent: string
  // Lowercase plural: the word for this harness's source units in counts and problem lines.
  readonly unitNoun: string
  // One lowercase word, unique among registered adapters, for the conversation filter.
  readonly filterAlias: string
  // Positive; bumped by any change to what importUnit returns for the same input.
  readonly parserVersion: number
  // `major.minor` strings, one per fixture set.
  readonly testedVersions: readonly string[]
  // The harness's own environment variables that move its data, the one that names its location first.
  readonly locationVariables: readonly ILocationVariable[]
}

// An environment variable a harness reads to find its data.
export interface ILocationVariable {
  readonly name: string
  // One line for the environment variables page: what setting it changes.
  readonly changes: string
}

// The only place an adapter reads the environment and the home directory from, never process.env or os.homedir(),
// so the conformance suite can point it at a fixture tree.
export interface IAdapterEnvironment {
  readonly variables: Readonly<Record<string, string | undefined>>
  // Absolute.
  readonly homeDir: string
  // Absolute: the directory logbook was started in.
  readonly cwd: string
  readonly platform: 'darwin' | 'linux'
}

export interface IHarnessLocation {
  // Absolute path of the directory or file the adapter reads.
  readonly root: string
  readonly kind: 'directory' | 'file'
  // One line for the start sequence: the location with the home directory shown as `~`, plus how locate chose when it
  // had a choice.
  readonly describe: string
}

// `lookedAt` is the absolute path the harness's own rule names for this environment, which locate checked and found
// missing or of the wrong kind; null only when the rule names no path at all.
export type LocateResult =
  | { readonly kind: 'found'; readonly location: IHarnessLocation }
  | { readonly kind: 'not-found'; readonly lookedAt: string | null }

export interface IAdapterContext {
  // Aborted on SIGINT or SIGTERM; an adapter checks it inside any loop over more than one file or row set and throws
  // its reason.
  readonly signal: AbortSignal
  // For a listing slow enough to report.
  readonly onProgress: (line: string) => void
  // The only way an adapter opens a SQLite file, always read-only.
  readonly openSqlite: typeof openSqlite
}

export interface ISourceUnit {
  // Unique within the adapter's list, stable across syncs, relative to the location's root.
  readonly locator: string
  // Non-empty, equal while the unit is unchanged, different after any change that could change importUnit's output.
  // Computed before the unit's content is read, so a unit that changes between listing and import is imported once
  // more next sync instead of never.
  readonly fingerprint: string
}

export interface IImportedUnit {
  readonly sessions: readonly IImportedSession[]
  // The newest harness version the unit recorded, or null.
  readonly harnessVersion: string | null
}

// The source's own format marker is newer than the newest one the adapter is tested with, or cannot be ordered: a
// notice only, whose words the engine builds.
export interface IFormatDrift {
  readonly seen: string
  readonly testedUpTo: string
}

// Opened once per sync. The engine calls close exactly once, in a finally, after openSource returned the reader, and
// close must not throw after a failed listing. importUnit is deterministic: no clock, no randomness, no dependence on
// directory listing order.
export interface ISourceReader {
  // Set by openSource and fixed for the reader's life; null when the markers agree or the harness records none.
  readonly formatDrift: IFormatDrift | null
  listUnits: () => Promise<readonly ISourceUnit[]>
  importUnit: (unit: ISourceUnit) => Promise<IImportedUnit>
  close: () => Promise<void>
}

export interface IPrompt {
  readonly actor: 'user' | 'harness'
  readonly text: string
  readonly projectDir: string | null
}

export interface IRecognisedCommand {
  readonly command: string
  readonly source: 'typed' | 'template'
  readonly hasFile: boolean
}

// Pure and synchronous: prepareCommands reads every file first.
export interface ICommandRecogniser {
  recognise: (prompt: IPrompt) => IRecognisedCommand | null
}

// What every harness adapter implements and the engine calls, so no code outside an adapter needs a harness id. Every
// method is async, because a harness may need decompression or keep its data behind an API. openSource releases
// anything it opened before it throws.
export interface IHarnessAdapter {
  readonly descriptor: IHarnessDescriptor
  locate: (env: IAdapterEnvironment) => Promise<LocateResult>
  openSource: (location: IHarnessLocation, context: IAdapterContext) => Promise<ISourceReader>
  prepareCommands: (
    location: IHarnessLocation | null,
    env: IAdapterEnvironment,
    projectDirs: readonly string[]
  ) => Promise<ICommandRecogniser>
}
