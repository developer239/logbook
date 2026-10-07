import { isAbsolute, join } from 'node:path'
import { LogBookError } from '@log-book/core'
import type {
  IAdapterContext,
  IAdapterEnvironment,
  IFormatDrift,
  IHarnessAdapter,
  IHarnessDescriptor,
  IHarnessLocation,
  IImportedUnit,
  ILocationVariable,
  IRecognisedCommand,
  ISourceReader,
  ISourceUnit,
  LocateResult,
} from '../contract.js'
import { ADAPTER_ERROR_CODES } from '../helpers.js'
import {
  breakRule,
  buildSession,
  INVENTED_ID,
  type IInventedSession,
  type InventedInvalidRule,
} from './invented-records.js'

// Paths in these options are relative to the environment's home.
export type InventedLocate =
  | {
      readonly kind: 'found'
      readonly root?: string
      readonly locationKind?: 'directory' | 'file'
      readonly describe?: string
    }
  | { readonly kind: 'not-found'; readonly lookedAt: string | null }
  | { readonly kind: 'throws'; readonly message: string }

export type InventedOpen =
  | { readonly kind: 'reader' }
  // ADAPTER_SOURCE_UNREADABLE or ADAPTER_FORMAT_UNSUPPORTED, naming the location.
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'throws'; readonly message: string }

export type InventedUnitFailure =
  | { readonly kind: 'gone' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'invalid'; readonly rule: InventedInvalidRule }
  | { readonly kind: 'throws'; readonly message: string }

export interface IInventedUnit {
  readonly locator: string
  // `<locator>@1` when left out.
  readonly fingerprint?: string
  // A session still in progress: the fingerprint differs on every listing.
  readonly isFingerprintChanging?: boolean
  // One session with a prompt and a reply when left out.
  readonly sessions?: readonly IInventedSession[]
  readonly harnessVersion?: string | null
  readonly failure?: InventedUnitFailure
}

export type InventedListing =
  | { readonly kind: 'units'; readonly units: readonly IInventedUnit[] }
  | { readonly kind: 'throws'; readonly message: string }

export type InventedCommands =
  // The command each prompt text recognises; any other prompt recognises none.
  | { readonly kind: 'recognises'; readonly prompts: Readonly<Record<string, IRecognisedCommand>> }
  | { readonly kind: 'throws'; readonly message: string }

export interface IInventedAdapterOptions {
  readonly name?: string
  readonly defaultAgent?: string
  readonly unitNoun?: string
  readonly filterAlias?: string
  readonly parserVersion?: number
  readonly testedVersions?: readonly string[]
  readonly locationVariables?: readonly ILocationVariable[]
  readonly locate?: InventedLocate
  readonly open?: InventedOpen
  // One value every reader carries, or one per reader in the order openSource returns them, the last repeating.
  readonly formatDrift?: IFormatDrift | null | readonly (IFormatDrift | null)[]
  readonly listing?: InventedListing
  readonly commands?: InventedCommands
}

export type InventedMethod = 'locate' | 'openSource' | 'listUnits' | 'importUnit' | 'close' | 'prepareCommands'

export interface IInventedCall {
  readonly method: InventedMethod
  readonly args: readonly unknown[]
}

export interface IInventedAdapter extends IHarnessAdapter {
  // Every method call in order, with its arguments (openSource without its context).
  readonly calls: readonly IInventedCall[]
}

const DEFAULT_UNITS: readonly IInventedUnit[] = [{ locator: 'unit-1' }]
const DEFAULT_ROOT = '.invented'

const underHome = (env: IAdapterEnvironment, path: string): string =>
  isAbsolute(path) ? path : join(env.homeDir, path)

const locateWith = (option: InventedLocate, env: IAdapterEnvironment): LocateResult => {
  if (option.kind === 'throws') {
    throw new Error(option.message)
  }
  if (option.kind === 'not-found') {
    return { kind: 'not-found', lookedAt: option.lookedAt === null ? null : underHome(env, option.lookedAt) }
  }
  const root = option.root ?? DEFAULT_ROOT
  return {
    kind: 'found',
    location: {
      root: underHome(env, root),
      kind: option.locationKind ?? 'directory',
      describe: option.describe ?? `~/${root}`,
    },
  }
}

const OPEN_FAILURES: Readonly<
  Record<InventedOpen['kind'], (option: InventedOpen, location: IHarnessLocation) => Error | null>
> = {
  reader: () => null,
  unreadable: (_option, location) =>
    new LogBookError(`Cannot open ${location.root}.`, ADAPTER_ERROR_CODES.ADAPTER_SOURCE_UNREADABLE),
  unsupported: (_option, location) =>
    new LogBookError(`${location.root} has no sessions table.`, ADAPTER_ERROR_CODES.ADAPTER_FORMAT_UNSUPPORTED),
  throws: (option) => new Error(option.kind === 'throws' ? option.message : ''),
}

type TDriftOption = IInventedAdapterOptions['formatDrift']

const isDriftList = (option: TDriftOption): option is readonly (IFormatDrift | null)[] => Array.isArray(option)

const driftOf = (option: TDriftOption, readerIndex: number): IFormatDrift | null => {
  if (isDriftList(option)) {
    return option[Math.min(readerIndex, option.length - 1)] ?? null
  }
  return option ?? null
}

const importWith = (location: IHarnessLocation, unit: IInventedUnit): IImportedUnit => {
  const path = join(location.root, unit.locator)
  const harnessVersion = unit.harnessVersion ?? null
  const sessions = (unit.sessions ?? [{}]).map((session) => buildSession(unit.locator, harnessVersion, session))
  const { failure } = unit
  if (failure?.kind === 'gone') {
    throw new LogBookError(`${path} is gone.`, ADAPTER_ERROR_CODES.ADAPTER_UNIT_GONE)
  }
  if (failure?.kind === 'unreadable') {
    throw new LogBookError(`Cannot read ${path}.`, ADAPTER_ERROR_CODES.ADAPTER_UNIT_UNREADABLE)
  }
  if (failure?.kind === 'throws') {
    throw new Error(failure.message)
  }
  return { sessions: failure === undefined ? sessions : breakRule(sessions, failure.rule), harnessVersion }
}

const recogniserWith = (option: InventedCommands): Readonly<Record<string, IRecognisedCommand>> => {
  if (option.kind === 'throws') {
    throw new Error(option.message)
  }
  return option.prompts
}

const descriptorOf = (options: IInventedAdapterOptions): IHarnessDescriptor => ({
  id: INVENTED_ID,
  name: options.name ?? 'Test Harness',
  defaultAgent: options.defaultAgent ?? 'main',
  unitNoun: options.unitNoun ?? 'units',
  filterAlias: options.filterAlias ?? 'invented',
  parserVersion: options.parserVersion ?? 1,
  testedVersions: options.testedVersions ?? ['1.0'],
  locationVariables: options.locationVariables ?? [],
})

// An in-memory adapter for engine and CLI tests, whose units, records and failures the test describes. It keeps every
// rule of the contract, and with no options it registers and syncs one valid unit.
export const inventedAdapter = (options: IInventedAdapterOptions = {}): IInventedAdapter => {
  const calls: IInventedCall[] = []
  const log = (method: InventedMethod, ...args: unknown[]): void => {
    calls.push({ method, args })
  }
  let readers = 0
  let listings = 0
  const units = options.listing?.kind === 'units' ? options.listing.units : DEFAULT_UNITS
  const fingerprintOf = (unit: IInventedUnit): string =>
    `${unit.fingerprint ?? `${unit.locator}@1`}${unit.isFingerprintChanging === true ? `#${String(listings)}` : ''}`

  const readerFor = (location: IHarnessLocation, context: IAdapterContext, readerIndex: number): ISourceReader => ({
    formatDrift: driftOf(options.formatDrift, readerIndex),
    listUnits: async () => {
      log('listUnits')
      context.signal.throwIfAborted()
      if (options.listing?.kind === 'throws') {
        throw new Error(options.listing.message)
      }
      listings += 1
      return Promise.resolve(units.map((unit) => ({ locator: unit.locator, fingerprint: fingerprintOf(unit) })))
    },
    importUnit: async (listed: ISourceUnit) => {
      log('importUnit', listed)
      const unit = units.find((candidate) => candidate.locator === listed.locator)
      if (unit === undefined) {
        throw new LogBookError(`${join(location.root, listed.locator)} is gone.`, ADAPTER_ERROR_CODES.ADAPTER_UNIT_GONE)
      }
      return Promise.resolve(importWith(location, unit))
    },
    close: async () => {
      log('close')
      return Promise.resolve()
    },
  })

  return {
    calls,
    descriptor: descriptorOf(options),
    locate: async (env) => {
      log('locate', env)
      return Promise.resolve(locateWith(options.locate ?? { kind: 'found' }, env))
    },
    openSource: async (location, context) => {
      log('openSource', location)
      const open = options.open ?? { kind: 'reader' }
      const failure = OPEN_FAILURES[open.kind](open, location)
      if (failure !== null) {
        throw failure
      }
      readers += 1
      return Promise.resolve(readerFor(location, context, readers - 1))
    },
    prepareCommands: async (location, env, projectDirs) => {
      log('prepareCommands', location, env, projectDirs)
      const prompts = recogniserWith(options.commands ?? { kind: 'recognises', prompts: {} })
      return Promise.resolve({ recognise: (prompt) => prompts[prompt.text] ?? null })
    },
  }
}
