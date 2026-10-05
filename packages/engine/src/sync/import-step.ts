import {
  ADAPTER_ERROR_CODES,
  compareHarnessVersions,
  validateImportedUnit,
  type IAdapterEnvironment,
  type IFormatDrift,
  type IHarnessAdapter,
  type IHarnessLocation,
  type IImportedUnit,
  type ISourceReader,
  type ISourceUnit,
} from '@log-book/adapter-api'
import { LogBookError, openSqlite } from '@log-book/core'
import type { WarehouseStore } from '@log-book/warehouse'

// Shown after each unit, so the host can show `412 of 412` or that every unit is read again.
export interface IUnitProgress {
  adapter: string
  done: number
  total: number
  // True while the adapter re-reads every unit because its parser version changed.
  reread: boolean
}

// One kind of problem in an adapter's step: the error code (null for an error the contract does not name, an adapter
// defect), how many units it hit, the first of them, and the reason.
interface IImportProblem {
  code: string | null
  units: number
  firstLocator: string | null
  reason: string
}

export type LocatedAdapter =
  | { kind: 'found'; adapter: IHarnessAdapter; location: IHarnessLocation }
  | { kind: 'not-found'; adapter: IHarnessAdapter; lookedAt: string | null; problem: IImportProblem | null }

// What one adapter's step reports, for the sync to store and the CLI to print. Paths are absolute.
export interface IImportReport {
  adapter: string
  isFound: boolean
  location: string | null
  lookedAt: string | null
  imported: number
  unchanged: number
  gone: number
  skipped: number
  isReread: boolean
  // The newest harness version among the units imported this sync.
  versionSeen: string | null
  formatDrift: IFormatDrift | null
  // The unknown events of the units imported this sync, by type.
  unknownByType: Record<string, number>
  problems: IImportProblem[]
}

export interface IImportContext {
  store: WarehouseStore
  signal: AbortSignal
  now: () => number
  onProgress: (progress: IUnitProgress) => void
  // A line of the sync log.
  log: (line: string) => void
}

const codeOf = (error: unknown): string | null => (error instanceof LogBookError ? error.code : null)

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const problemOf = (error: unknown, firstLocator: string | null = null): IImportProblem => ({
  code: codeOf(error),
  units: firstLocator === null ? 0 : 1,
  firstLocator,
  reason: reasonOf(error),
})

// Runs `work` for each item in order, one at a time: an adapter never has two methods running.
const inOrder = async <TItem>(
  items: readonly TItem[],
  work: (item: TItem, index: number) => Promise<void>
): Promise<void> =>
  items.reduce(async (previous, item, index) => {
    await previous
    await work(item, index)
  }, Promise.resolve())

// Every adapter's location, once per sync, before any import step. A locate that throws is a defect: the adapter
// counts as not found, with no location.
export const locateAdapters = async (
  adapters: readonly IHarnessAdapter[],
  env: IAdapterEnvironment
): Promise<LocatedAdapter[]> => {
  const located: LocatedAdapter[] = []
  await inOrder(adapters, async (adapter) => {
    try {
      const result = await adapter.locate(env)
      located.push(
        result.kind === 'found'
          ? { kind: 'found', adapter, location: result.location }
          : { kind: 'not-found', adapter, lookedAt: result.lookedAt, problem: null }
      )
    } catch (error: unknown) {
      located.push({ kind: 'not-found', adapter, lookedAt: null, problem: problemOf(error) })
    }
  })
  return located
}

const isAbort = (error: unknown, signal: AbortSignal): boolean => signal.aborted && error === signal.reason

// One found adapter's step: open, list, import what changed, validate, store, close.
class ImportStep {
  private readonly adapter: IHarnessAdapter
  private readonly location: IHarnessLocation
  private readonly context: IImportContext
  private readonly report: IImportReport
  private readonly unitProblems = new Map<string, IImportProblem>()

  constructor(adapter: IHarnessAdapter, location: IHarnessLocation, context: IImportContext) {
    this.adapter = adapter
    this.location = location
    this.context = context
    this.report = {
      ...emptyReport(adapter.descriptor.id),
      isFound: true,
      location: location.root,
    }
  }

  public readonly run = async (): Promise<IImportReport> => {
    let reader: ISourceReader
    try {
      reader = await this.adapter.openSource(this.location, {
        signal: this.context.signal,
        onProgress: this.context.log,
        openSqlite,
      })
    } catch (error: unknown) {
      this.rethrowAbort(error)
      return this.end(problemOf(error))
    }
    // Read before the listing, so a drift is reported on every sync.
    this.report.formatDrift = reader.formatDrift
    try {
      await this.readUnits(reader)
    } finally {
      await reader.close()
    }
    return this.end(null)
  }

  private readonly readUnits = async (reader: ISourceReader): Promise<void> => {
    let units: readonly ISourceUnit[]
    try {
      units = await reader.listUnits()
    } catch (error: unknown) {
      this.rethrowAbort(error)
      this.report.problems.push(problemOf(error))
      return
    }
    const duplicate = units.find((unit, index) => units.findIndex((other) => other.locator === unit.locator) !== index)
    if (duplicate !== undefined) {
      this.report.problems.push({
        code: ADAPTER_ERROR_CODES.ADAPTER_OUTPUT_INVALID,
        units: 0,
        firstLocator: duplicate.locator,
        reason: `two units share the locator ${duplicate.locator}`,
      })
      return
    }
    const { id, parserVersion } = this.adapter.descriptor
    const states = units.map((unit) => this.context.store.readSourceState(id, unit.locator))
    this.report.isReread = states.some((state) => state !== null && state.parserVersion !== parserVersion)
    await inOrder(units, async (unit, index) => {
      this.context.signal.throwIfAborted()
      const state = states[index] ?? null
      if (state !== null && state.fingerprint === unit.fingerprint && state.parserVersion === parserVersion) {
        this.report.unchanged += 1
      } else {
        await this.importUnit(reader, unit)
      }
      this.context.onProgress({ adapter: id, done: index + 1, total: units.length, reread: this.report.isReread })
    })
  }

  private readonly importUnit = async (reader: ISourceReader, unit: ISourceUnit): Promise<void> => {
    let imported: IImportedUnit
    try {
      imported = await reader.importUnit(unit)
    } catch (error: unknown) {
      this.rethrowAbort(error)
      this.unitFailed(unit, error)
      return
    }
    const broken = validateImportedUnit(this.adapter.descriptor, imported)
    if (broken.length > 0) {
      for (const rule of broken) {
        this.context.log(`${this.adapter.descriptor.id} ${unit.locator}: ${rule}`)
      }
      this.unitFailed(unit, new LogBookError(broken[0] ?? '', ADAPTER_ERROR_CODES.ADAPTER_OUTPUT_INVALID))
      return
    }
    this.context.store.writeImportedUnit(imported.sessions, {
      harness: this.adapter.descriptor.id,
      locator: unit.locator,
      fingerprint: unit.fingerprint,
      parserVersion: this.adapter.descriptor.parserVersion,
      importedAt: this.context.now(),
    })
    this.report.imported += 1
    this.noteImported(imported)
  }

  // A gone unit keeps its rows and is no problem; any other failure skips the unit and keeps its source state, so the
  // next sync tries it again.
  private readonly unitFailed = (unit: ISourceUnit, error: unknown): void => {
    const code = codeOf(error)
    if (code === ADAPTER_ERROR_CODES.ADAPTER_UNIT_GONE) {
      this.report.gone += 1
      return
    }
    this.report.skipped += 1
    if (code === null) {
      this.context.log(
        `${this.adapter.descriptor.id} ${unit.locator}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
      )
    }
    const key = String(code)
    const known = this.unitProblems.get(key)
    if (known === undefined) {
      this.unitProblems.set(key, problemOf(error, unit.locator))
    } else {
      known.units += 1
    }
  }

  private readonly noteImported = (imported: IImportedUnit): void => {
    const version = imported.harnessVersion
    if (
      version !== null &&
      (this.report.versionSeen === null || (compareHarnessVersions(version, this.report.versionSeen) ?? 0) > 0)
    ) {
      this.report.versionSeen = version
    }
    for (const event of imported.sessions.flatMap((session) => session.events)) {
      if (event.kind === 'unknown') {
        const { type } = JSON.parse(event.dataJson) as { type: string | null }
        const key = String(type)
        this.report.unknownByType[key] = (this.report.unknownByType[key] ?? 0) + 1
      }
    }
  }

  private readonly rethrowAbort = (error: unknown): void => {
    if (isAbort(error, this.context.signal)) {
      throw error
    }
  }

  private readonly end = (problem: IImportProblem | null): IImportReport => {
    this.report.problems.push(...(problem === null ? [] : [problem]), ...this.unitProblems.values())
    return this.report
  }
}

const emptyReport = (adapter: string): IImportReport => ({
  adapter,
  isFound: false,
  location: null,
  lookedAt: null,
  imported: 0,
  unchanged: 0,
  gone: 0,
  skipped: 0,
  isReread: false,
  versionSeen: null,
  formatDrift: null,
  unknownByType: {},
  problems: [],
})

// One adapter's import step. A not-found adapter's step ends at once, with its locate defect when it had one. The
// abort signal's reason stops the step; it is not a defect.
export const importAdapter = async (located: LocatedAdapter, context: IImportContext): Promise<IImportReport> => {
  if (located.kind === 'not-found') {
    return {
      ...emptyReport(located.adapter.descriptor.id),
      lookedAt: located.lookedAt,
      problems: located.problem === null ? [] : [located.problem],
    }
  }
  return new ImportStep(located.adapter, located.location, context).run()
}
