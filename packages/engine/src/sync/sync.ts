import {
  ADAPTER_ERROR_CODES,
  compareHarnessVersions,
  type IAdapterEnvironment,
  type IHarnessAdapter,
  type IHarnessDescriptor,
} from '@log-book/adapter-api'
import { takeSyncLock, WarehouseStore, type SyncOutcome } from '@log-book/warehouse'
import { deriveCommands } from '../derive/commands.js'
import { deriveInitiators, deriveLinks } from '../derive/links.js'
import { deriveToolCallRules } from '../derive/tool-call-rules.js'
import { deriveTurns } from '../derive/turn-time.js'
import { adapterEnvironment, withHomeAsTilde } from '../home-path.js'
import {
  importAdapter,
  locateAdapters,
  type IImportReport,
  type IUnitProgress,
  type LocatedAdapter,
} from './import-step.js'

export type SyncProgress = IUnitProgress | { phase: 'derivations' }

// One adapter's part of a sync, for the CLI to print. The location is in the `~/` form.
export interface ISyncAdapterResult {
  name: string
  isFound: boolean
  location: string | null
  imported: number
  unchanged: number
  gone: number
  skipped: number
  isReread: boolean
  unknownByType: Record<string, number>
  notice: string | null
}

export interface ISyncResult {
  outcome: Exclude<SyncOutcome, 'failed'>
  adapters: ISyncAdapterResult[]
  // In order, in the `~/` form; the first is the record's error of a partial sync.
  problems: string[]
  sessions: number
  durationMs: number
}

export interface ISyncRun {
  adapters: readonly IHarnessAdapter[]
  warehousePath: string
  onProgress: (progress: SyncProgress) => void
  signal: AbortSignal
}

// The newest of an adapter's tested `major.minor` versions.
const newestTested = ({ testedVersions }: IHarnessDescriptor): string =>
  testedVersions.reduce((newest, version) => ((compareHarnessVersions(version, newest) ?? 0) > 0 ? version : newest))

// The drift notice: the version sentence when the newest version the step saw is newer than every tested one, or
// cannot be compared, then the format sentence when the reader reported a drift; null when neither applies.
const noticeOf = (descriptor: IHarnessDescriptor, report: IImportReport): string | null => {
  const tested = descriptor.testedVersions.join(', ')
  const sentences: string[] = []
  const seen = report.versionSeen
  if (seen !== null) {
    const majorMinor = seen.split('.').slice(0, 2).join('.')
    if (compareHarnessVersions(seen, seen) === null) {
      sentences.push(
        `Recorded by ${descriptor.name} version ${seen}, which this Log Book cannot compare; it is tested with ${tested}.`
      )
    } else if (descriptor.testedVersions.every((version) => (compareHarnessVersions(majorMinor, version) ?? 0) > 0)) {
      sentences.push(`Recorded by ${descriptor.name} ${seen}; this Log Book is tested with ${tested}.`)
    }
  }
  if (report.formatDrift !== null) {
    sentences.push(
      `${descriptor.name} data was written in format ${report.formatDrift.seen}; this Log Book is tested up to ${report.formatDrift.testedUpTo}.`
    )
  }
  return sentences.length === 0 ? null : sentences.join(' ')
}

// The words of each problem of an adapter's step, and whether it ended the step.
const problemLinesOf = (
  descriptor: IHarnessDescriptor,
  report: IImportReport
): { line: string; isStepEnd: boolean }[] =>
  report.problems.map((problem) => {
    const { name, unitNoun } = descriptor
    if (problem.units > 0 && problem.code === ADAPTER_ERROR_CODES.ADAPTER_UNIT_UNREADABLE) {
      return {
        line: `${name}: ${String(problem.units)} ${unitNoun} could not be read: ${String(problem.firstLocator)}: ${problem.reason}`,
        isStepEnd: false,
      }
    }
    if (problem.units > 0) {
      return {
        line: `${name}: ${String(problem.units)} ${unitNoun} skipped, an adapter defect: ${problem.reason}`,
        isStepEnd: false,
      }
    }
    if (problem.code === ADAPTER_ERROR_CODES.ADAPTER_SOURCE_UNREADABLE) {
      return { line: `${name}: cannot read ${String(report.location)}: ${problem.reason}`, isStepEnd: true }
    }
    if (
      problem.code === ADAPTER_ERROR_CODES.ADAPTER_FORMAT_UNSUPPORTED ||
      problem.code === ADAPTER_ERROR_CODES.ADAPTER_OUTPUT_INVALID
    ) {
      return {
        line: `${name}: ${problem.reason}; this Log Book reads ${name} ${newestTested(descriptor)}. Upgrade Log Book.`,
        isStepEnd: true,
      }
    }
    return { line: `${name}: skipped this sync, an adapter defect: ${problem.reason}`, isStepEnd: true }
  })

const lastLineOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .at(-1) ?? ''

// The derivations, each replacing its output in its own transaction, in an order that is load-bearing: turn placement
// reads links, and recovery reads shell purposes.
const derive = async (
  store: WarehouseStore,
  located: readonly LocatedAdapter[],
  env: IAdapterEnvironment,
  now: number
): Promise<string[]> => {
  deriveLinks(store)
  const commandProblems = await deriveCommands(store, located, env)
  deriveTurns(store)
  deriveToolCallRules(store, now)
  deriveInitiators(store, now)
  return commandProblems.map((problem) => {
    const name = located.find((candidate) => candidate.adapter.descriptor.id === problem.adapter)?.adapter.descriptor
      .name
    return `${name ?? problem.adapter}: commands not recognised this sync, an adapter defect: ${problem.reason}`
  })
}

// Brings the warehouse up to date with every registered adapter under the sync lock, with its sync record. It never
// calls a model. A held lock throws before any record is written; an error that ends the whole sync is recorded as
// `failed` and thrown; an abort through the signal ends it `stopped`.
export const runSync = async (run: ISyncRun): Promise<ISyncResult> => {
  const startedAt = Date.now()
  const env = adapterEnvironment()
  const tilde = (text: string): string => withHomeAsTilde(text, env.homeDir)
  const tildeOrNull = (text: string | null): string | null => (text === null ? null : tilde(text))
  const store = await WarehouseStore.open(run.warehousePath)
  let lock: ReturnType<typeof takeSyncLock>
  try {
    lock = takeSyncLock(run.warehousePath, 'sync')
  } catch (error: unknown) {
    store.close()
    throw error
  }
  const recordId = store.startSyncRecord(startedAt)
  const problems: string[] = []
  const adapters: ISyncAdapterResult[] = []
  let outcome: SyncOutcome = 'failed'
  let error: string | null = null
  const finish = (ended: ISyncResult['outcome']): ISyncResult => {
    outcome = ended
    return {
      outcome: ended,
      adapters,
      problems,
      sessions: store.get<{ count: number }>('SELECT count(*) AS count FROM session')?.count ?? 0,
      durationMs: Date.now() - startedAt,
    }
  }
  try {
    const located = await locateAdapters(run.adapters, env)
    store.writeHarnessDescriptors(
      located.map(({ adapter: { descriptor }, ...answer }) => {
        const where = answer.kind === 'found' ? answer.location.root : answer.lookedAt
        return {
          id: descriptor.id,
          name: descriptor.name,
          defaultAgent: descriptor.defaultAgent,
          filterAlias: descriptor.filterAlias,
          isFound: answer.kind === 'found',
          checkedAt: Date.now(),
          location: where === null ? null : tilde(where),
          locationVariables: descriptor.locationVariables.map(({ name }) => name),
        }
      })
    )
    await located.reduce(async (previous, adapter) => {
      await previous
      const report = await importAdapter(adapter, {
        store,
        signal: run.signal,
        now: () => Date.now(),
        onProgress: run.onProgress,
        log: () => undefined,
      })
      const { descriptor } = adapter.adapter
      const lines = problemLinesOf(descriptor, {
        ...report,
        location: report.location === null ? null : tilde(report.location),
      })
      const notice = noticeOf(descriptor, report)
      store.writeHarnessStepEnd(descriptor.id, {
        versionSeen: report.versionSeen,
        notice,
        problem: tildeOrNull(lines.find((line) => line.isStepEnd)?.line ?? null),
      })
      problems.push(...lines.map(({ line }) => tilde(line)))
      adapters.push({
        name: descriptor.name,
        isFound: report.isFound,
        location: report.location === null ? null : tilde(report.location),
        imported: report.imported,
        unchanged: report.unchanged,
        gone: report.gone,
        skipped: report.skipped,
        isReread: report.isReread,
        unknownByType: report.unknownByType,
        notice,
      })
    }, Promise.resolve())
    run.onProgress({ phase: 'derivations' })
    problems.push(...(await derive(store, located, env, Date.now())).map(tilde))
    error = problems[0] ?? null
    return finish(problems.length === 0 ? 'ok' : 'partial')
  } catch (caught: unknown) {
    if (run.signal.aborted) {
      return finish('stopped')
    }
    error = tilde(lastLineOf(caught))
    throw caught
  } finally {
    store.endSyncRecord(recordId, { endedAt: Date.now(), outcome, error })
    lock.release()
    store.close()
  }
}
