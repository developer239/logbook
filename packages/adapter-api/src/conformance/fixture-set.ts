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

// A committed fixture tree of one tested harness version, with what the suite needs to drive it. Its golden files sit
// in `<root>/expected/`: `<locator>.json` per unit and `commands.json` with the prompts and their expected answers,
// project directories relative to the home. `expected/` is never copied into a case's home.
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
}

export interface IConformanceCase {
  // `<fixture version>: <case name>`.
  readonly name: string
  // Throws on failure.
  readonly run: () => Promise<void>
}
