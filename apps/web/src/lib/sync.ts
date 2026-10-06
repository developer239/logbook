import { readSyncLock, resolveWarehousePath, SYNC_TIMEOUT_MS } from '@log-book/warehouse'
import { EXIT, failureOf, runLogbook, type IChildRegistry } from './cli'
import { CliError } from './errors'

// How often a request that met a running sync looks at the lock again.
export const LOCK_POLL_MS = 500

let running: Promise<void> | undefined

const isMaintenance = (operation: string | null): boolean => operation === 'compact' || operation === 'forget'

const pause = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })

// A sync someone else runs (the scheduler's or a terminal's) brings the fresh data the user clicked for, so the request
// waits until the lock is free or held by maintenance, which it does not wait out; but not past the engine's sync
// timeout from the sync's start, after which the host stops it as failed.
const waitForSync = async (warehousePath: string): Promise<void> => {
  const lock = readSyncLock(warehousePath)
  if (!lock.isHeld || lock.operation !== 'sync') {
    return
  }
  if (lock.startedAt !== null && Date.now() - lock.startedAt >= SYNC_TIMEOUT_MS) {
    throw new CliError('A sync has been running for over 30 minutes.')
  }
  await pause(LOCK_POLL_MS)
  await waitForSync(warehousePath)
}

// The web app never writes the warehouse: it runs `logbook sync` and learns from its exit code. Resolves once the
// page can return to where the user clicked; a failure throws a CliError with the message to show.
const runSync = async (children: IChildRegistry | undefined): Promise<void> => {
  const warehousePath = resolveWarehousePath()
  // A compaction or a forget holds the lock for minutes and brings no new data; the Sync control shows it. A lock its
  // holder left behind holds nothing.
  const lock = readSyncLock(warehousePath)
  if (lock.isHeld && isMaintenance(lock.operation)) {
    return
  }
  const run = await runLogbook(['sync'], children)
  if (run.code === EXIT.success || run.code === EXIT.partialFailure) {
    return
  }
  if (run.code === EXIT.alreadyRunning) {
    await waitForSync(warehousePath)
    return
  }
  throw failureOf('sync', run)
}

// One sync per web process: a request that comes while one runs joins it.
export const sync = async (children?: IChildRegistry): Promise<void> => {
  running ??= runSync(children).finally(() => {
    running = undefined
  })
  return running
}
