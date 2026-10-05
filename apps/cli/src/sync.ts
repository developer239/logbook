import { MarkdownBuilder } from '@log-book/core'
import { createEngine, type ISyncAdapterResult, type ISyncResult, type SyncProgress } from '@log-book/engine'
import { resolveWarehousePath } from '@log-book/warehouse'
import { exitCodeOf } from './errors.js'
import { formatCount, formatDuration } from './format.js'
import { ADAPTERS } from './grammar.js'
import type { CommandRunner } from './run-cli.js'

// What a sync sends its parent when the parent gave it an IPC channel.
export type SyncMessage =
  | { type: 'progress'; adapter: string; done: number; total: number; reread: boolean }
  | { type: 'phase'; name: 'derivations' }
  | { type: 'done'; imported: number; unchanged: number; ms: number }

type SendMessage = (message: SyncMessage) => void

// Runs the engine's sync, reporting its progress as it goes.
export type StartSync = (options: {
  signal: AbortSignal
  onProgress: (progress: SyncProgress) => void
}) => Promise<ISyncResult>

const TENTHS = 10

const line = (text: string): string => `${text}\n`

const plural = (count: number, one: string, many: string): string => `${formatCount(count)} ${count === 1 ? one : many}`

const nameOf = (adapterId: string): string => {
  const found = ADAPTERS.find(({ descriptor }) => descriptor.id === adapterId)
  if (found === undefined) {
    throw new Error(`No registered adapter has the id ${adapterId}`)
  }
  return found.descriptor.name
}

// The records kept as unknown, the commonest type first and ties by type: `3 records not recognised (a 2, b 1)`.
const unknownPart = (unknownByType: Readonly<Record<string, number>>): string | null => {
  const types = Object.entries(unknownByType).toSorted(([firstType, firstCount], [secondType, secondCount]) =>
    secondCount === firstCount ? firstType.localeCompare(secondType) : secondCount - firstCount
  )
  const total = types.reduce((sum, [, count]) => sum + count, 0)
  if (total === 0) {
    return null
  }
  const byType = types.map(([type, count]) => `${type} ${formatCount(count)}`).join(', ')
  return `${plural(total, 'record', 'records')} not recognised (${byType})`
}

// One adapter's field: its counts, zero ones left out except imported and unchanged, then its notice as given.
const adapterValue = (adapter: ISyncAdapterResult): string => {
  if (!adapter.isFound) {
    return 'not on this machine'
  }
  const parts = [
    `${formatCount(adapter.imported)} imported`,
    `${formatCount(adapter.unchanged)} unchanged`,
    adapter.gone === 0 ? null : `${formatCount(adapter.gone)} gone while reading`,
    adapter.skipped === 0 ? null : `${formatCount(adapter.skipped)} skipped`,
    unknownPart(adapter.unknownByType),
  ].filter((part) => part !== null)
  const counts = parts.join(', ')
  return adapter.notice === null ? counts : `${counts}. ${adapter.notice}`
}

// The stdout summary of a sync, one field per adapter and two for the whole sync.
export const syncSummary = (result: ISyncResult): string => {
  const summary = MarkdownBuilder.create().heading('Sync', 1)
  for (const adapter of result.adapters) {
    summary.field(adapter.name, adapterValue(adapter))
  }
  return summary
    .field('Sessions in the warehouse', formatCount(result.sessions))
    .field('Took', formatDuration(result.durationMs))
    .build()
}

const progressLine = ({ adapter, done, total, reread }: Extract<SyncProgress, { adapter: string }>): string =>
  `${nameOf(adapter)}: ${formatCount(done)} of ${formatCount(total)} ${reread ? 'read again for this version' : 'checked'}`

// The stderr lines and IPC messages of the engine's progress. A line comes at an adapter's first unit, every tenth of
// its units and its last one, so a long history does not flood the terminal; every event goes to the parent.
const progressReporter = (stderr: (text: string) => void, send: SendMessage | undefined) => {
  const tenthsWritten = new Map<string, number>()
  return (progress: SyncProgress): void => {
    if ('phase' in progress) {
      stderr(line('Working out the derived facts'))
      send?.({ type: 'phase', name: progress.phase })
      return
    }
    const tenth = Math.floor((progress.done * TENTHS) / progress.total)
    if (tenthsWritten.get(progress.adapter) !== tenth || progress.done === progress.total) {
      tenthsWritten.set(progress.adapter, tenth)
      stderr(line(progressLine(progress)))
    }
    send?.({ type: 'progress', ...progress })
  }
}

const doneMessage = (result: ISyncResult): SyncMessage => ({
  type: 'done',
  imported: result.adapters.reduce((sum, adapter) => sum + adapter.imported, 0),
  unchanged: result.adapters.reduce((sum, adapter) => sum + adapter.unchanged, 0),
  ms: result.durationMs,
})

// The parent's channel when it forked this process with one; no flag decides it.
export const ipcChannel = (): SendMessage | undefined => {
  if (process.send === undefined) {
    return undefined
  }
  return (message) => {
    process.send?.(message)
  }
}

// The engine's sync over the registered adapters and the resolved warehouse.
const engineSync: StartSync = async ({ signal, onProgress }) =>
  createEngine({ adapters: ADAPTERS, warehousePath: resolveWarehousePath(), onProgress }).sync({ signal })

// `logbook sync`. A held lock, a newer warehouse and a failure are thrown by the engine and end the command through
// its error line; a stopped sync keeps what it committed.
export const createSyncRunner =
  (startSync: StartSync = engineSync, channel: () => SendMessage | undefined = ipcChannel): CommandRunner =>
  async ({ io }) => {
    const send = channel()
    const result = await startSync({ signal: io.signal, onProgress: progressReporter(io.stderr, send) })
    send?.(doneMessage(result))
    if (result.outcome === 'stopped') {
      return exitCodeOf('interrupted')
    }
    io.stdout(line(syncSummary(result)))
    if (result.outcome === 'ok') {
      return exitCodeOf('success')
    }
    const [first] = result.problems
    if (first === undefined) {
      throw new Error('A partial sync came back without a problem line')
    }
    for (const problem of result.problems) {
      io.stderr(line(problem))
    }
    const count = plural(result.problems.length, 'problem', 'problems')
    io.stderr(line(`Sync finished with ${count}: ${first}`))
    return exitCodeOf('partial failure')
  }
