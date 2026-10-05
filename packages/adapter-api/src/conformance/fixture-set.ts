import type { IAdapterEnvironment } from '../contract.js'

// One unit a fixture set holds, and what its import must show.
export interface IFixtureUnit {
  readonly locator: string
  // The harness version the unit's import reports.
  readonly harnessVersion: string | null
  // The raw records the adapter does not know, each kept as exactly one `unknown` event: its `raw`, or its `value`
  // for an unrecognised value of a known field.
  readonly unknownRecords: readonly unknown[]
}

// One discovery case of the harness's location rule, laid out in a fresh empty home. Paths in `expected` are relative
// to the home.
export interface ILocateVariant {
  readonly name: string
  readonly arrange: (home: string) => Promise<void>
  readonly environment: (home: string) => IAdapterEnvironment
  readonly expected:
    | { readonly kind: 'found'; readonly root: string }
    | { readonly kind: 'not-found'; readonly lookedAt: string | null }
}

// A committed fixture tree of one tested harness version, with what the suite needs to drive it. Its harness files sit
// in `<root>/home/`, which each case copies as its home, and its golden files in `<root>/expected/`: `<locator>.json`
// per unit and `commands.json` with the prompts and their expected answers, project directories relative to the home.
export interface IFixtureSet {
  // `major.minor`, one of the adapter's `testedVersions`.
  readonly harnessVersion: string
  // Directory of the committed fixture tree.
  readonly root: string
  // The kind of location `locate` finds in the tree.
  readonly locationKind: 'directory' | 'file'
  readonly units: readonly IFixtureUnit[]
  // The environment for a copy of the tree whose home is `home`: the harness's variables pointing into it.
  readonly environment: (home: string) => IAdapterEnvironment
  // Builds what is not committed as harness files, such as a database from SQL text.
  readonly prepare: (home: string) => Promise<void>
  // Changes one unit the way the harness would, and sets the modification time of every file it changes to a fixed
  // time later than any in the set, so a fingerprint never depends on the clock's resolution.
  readonly change: (home: string, locator: string) => Promise<void>
  // Removes one unit between listing and import.
  readonly remove: (home: string, locator: string) => Promise<void>
  readonly locateVariants: readonly ILocateVariant[]
  // For a database harness: builds the fixture database the way a running harness leaves it (journal mode WAL, rows
  // still only in the `-wal`, a writer connection held open) instead of `prepare`, and returns what closes that
  // connection. Its units must equal the golden files.
  readonly prepareLive?: (home: string) => Promise<() => void>
  // Paths relative to the home the adapter never reads: credentials, settings, instruction files.
  readonly neverRead: readonly string[]
}

export interface IConformanceCase {
  // `<fixture version>: <case name>`.
  readonly name: string
  // Throws on failure.
  readonly run: () => Promise<void>
}
