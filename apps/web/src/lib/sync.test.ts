import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYNC_TIMEOUT_MS, takeSyncLock } from '@log-book/warehouse'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliError } from './errors'
import { LOCK_POLL_MS, sync } from './sync'
import { logbookStub, type ILogbookStub } from './testing/logbook-stub'

// A pid no process has.
const DEAD_PID = 999_999

let directory = ''
let warehouse = ''
let stub: ILogbookStub

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'web-sync-'))
  warehouse = join(directory, 'warehouse.db')
  vi.stubEnv('LOGBOOK_DB', warehouse)
  stub = await logbookStub(directory)
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

// Whether the promise has settled after the lock was looked at a few times.
const isSettledAfterPolls = async (promise: Promise<unknown>): Promise<boolean> => {
  let isSettled = false
  void promise.finally(() => {
    isSettled = true
  })
  await new Promise((resolve) => {
    setTimeout(resolve, LOCK_POLL_MS * 3)
  })
  return isSettled
}

describe('sync', () => {
  it('runs logbook sync and resolves on exit 0', async () => {
    // Act
    await sync()

    // Assert
    expect(await stub.calls()).toStrictEqual([['sync']])
  })

  it('resolves on a partial sync, which brought what it could read', async () => {
    // Arrange
    stub.answer(10, ['Sync finished with 1 problem: example'])

    // Act
    const syncing = sync()

    // Assert
    await expect(syncing).resolves.toBeUndefined()
  })

  it('fails with the last stderr line of a failed sync', async () => {
    // Arrange
    stub.answer(1, ['Working out the derived facts', 'disk full'])

    // Act
    const syncing = sync()

    // Assert
    await expect(syncing).rejects.toThrow(new CliError('logbook sync failed: disk full'))
  })

  it('fails with the update sentence on exit 9', async () => {
    // Arrange
    stub.answer(9)

    // Act
    const syncing = sync()

    // Assert
    await expect(syncing).rejects.toThrow(
      new CliError('Log Book was updated while running. Press Ctrl+C and start logbook again.')
    )
  })

  it('waits on exit 3 while another sync holds the lock, and resolves once it is released', async () => {
    // Arrange
    stub.answer(3)
    const lock = takeSyncLock(warehouse, 'sync')

    // Act
    const syncing = sync()
    const isSettledWhileHeld = await isSettledAfterPolls(syncing)
    lock.release()
    await syncing

    // Assert
    expect(isSettledWhileHeld).toBe(false)
  })

  it('resolves at once when the waited-for sync hands the lock to a compaction', async () => {
    // Arrange
    stub.answer(3)
    const lock = takeSyncLock(warehouse, 'sync')
    const syncing = sync()
    await isSettledAfterPolls(syncing)

    // Act
    lock.release()
    const compaction = takeSyncLock(warehouse, 'compact')
    await syncing
    compaction.release()

    // Assert
    expect(await stub.calls()).toStrictEqual([['sync']])
  })

  it('stops waiting 30 minutes after the running sync started', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    stub.answer(3)
    const lock = takeSyncLock(warehouse, 'sync')
    const syncing = sync()
    const failed = expect(syncing).rejects.toThrow(new CliError('A sync has been running for over 30 minutes.'))

    // Act
    await vi.waitFor(async () => {
      expect(await stub.calls()).toHaveLength(1)
    })
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUT_MS)

    // Assert
    await failed
    lock.release()
  })

  it('starts no sync while a forget holds the lock', async () => {
    // Arrange
    const lock = takeSyncLock(warehouse, 'forget')

    // Act
    await sync()
    lock.release()

    // Assert
    expect(await stub.calls()).toStrictEqual([])
  })

  it('runs the sync when a forget that has ended left its lock behind', async () => {
    // Arrange
    const lock = takeSyncLock(warehouse, 'forget', { pid: DEAD_PID })

    // Act
    await sync()
    lock.release()

    // Assert
    expect(await stub.calls()).toStrictEqual([['sync']])
  })

  it('runs one sync for two requests that come together', async () => {
    // Act
    await Promise.all([sync(), sync()])

    // Assert
    expect(await stub.calls()).toStrictEqual([['sync']])
  })
})
