import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import type { ISqliteDb } from '@log-book/core'
import { readSyncLock, SCHEMA_VERSION, takeSyncLock, type IHeldLock } from '@log-book/warehouse'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as State from './state'
import { session, START } from './testing/rows'
import { insert, seedWarehouse, type ITestWarehouse } from './testing/warehouse'
import { MINUTE } from './time'

const RUN_IN_TERMINAL = 'Run logbook sync in a terminal to see the full output.'

let warehouse: ITestWarehouse
let db: ISqliteDb
let state: typeof State
// A process the test keeps alive, so a lock that names it is held.
let holder: ChildProcess
let holderPid = 0
let held: IHeldLock | undefined

const holdLock = (operation: 'sync' | 'compact' | 'forget'): number => {
  held = takeSyncLock(warehouse.path, operation, { pid: holderPid })
  return readSyncLock(warehouse.path).startedAt ?? 0
}

const record = (outcome: string | null, error: string | null = null, isEnded = true): void => {
  insert(db, 'sync_run', {
    started_at: START,
    ended_at: isEnded ? START + 1000 : null,
    outcome,
    error,
  })
}

const withSession = (): void => {
  session(db, {
    id: 'one:demo-0001',
    harness: 'one',
    origin: 'interactive',
    title: 'One',
    startedAt: START,
    endedAt: START,
  })
}

const harness = (row: { id: string; name: string } & Record<string, unknown>): void => {
  insert(db, 'harness', {
    default_agent: 'helper',
    filter_alias: row.id,
    is_found: 0,
    checked_at: START,
    location_variables: '[]',
    ...row,
  })
}

beforeAll(async () => {
  warehouse = await seedWarehouse((seeded) => {
    db = seeded
  })
  state = await import('./state')
  holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
  if (holder.pid === undefined) {
    throw new Error('The process that holds the test locks did not start')
  }
  holderPid = holder.pid
})

afterEach(() => {
  held?.release()
  held = undefined
  db.exec(
    `DELETE FROM session; DELETE FROM sync_run; DELETE FROM harness; PRAGMA user_version = ${String(SCHEMA_VERSION)}`
  )
})

afterAll(async () => {
  const exited = once(holder, 'exit')
  holder.kill()
  await exited
  await warehouse.remove()
})

describe('first run, while a sync runs', () => {
  it('shows the first sync running, with the seconds since the lock was taken, and reloads', () => {
    // Arrange
    const startedAt = holdLock('sync')

    // Act
    const shown = state.firstRun(startedAt + 42_000)

    // Assert
    expect(shown).toStrictEqual({
      kind: 'first-sync',
      status: 200,
      headline:
        "Log Book is reading your agents' history for the first time. A sync is running, started 42 seconds ago.",
      harnesses: [],
      notes: [],
      canSync: true,
      isReloading: true,
    })
  })

  it.each(['compact', 'forget'] as const)(
    'follows the sync record while %s holds the lock, never the first sync',
    (operation) => {
      // Arrange
      holdLock(operation)
      record('ok')

      // Act
      const overOk = state.firstRun()?.kind
      record(null, null, false)
      const overUnended = state.firstRun()?.kind

      // Assert
      expect([overOk, overUnended]).toStrictEqual(['nothing-found', 'sync-failed'])
    }
  )
})

describe('first run, after a sync', () => {
  it('lists each harness not found, with where it looked and the variable that points it elsewhere', () => {
    // Arrange
    record('ok')
    harness({
      id: 'example',
      name: 'Example Harness',
      location: '~/.example/data',
      location_variables: '["EXAMPLE_HOME"]',
    })
    harness({ id: 'sample', name: 'Sample Harness' })

    // Act
    const shown = state.firstRun()

    // Assert
    expect(shown).toStrictEqual({
      kind: 'nothing-found',
      status: 200,
      headline: 'No agent data found yet.',
      harnesses: [
        {
          name: 'Example Harness',
          text: 'not found at ~/.example/data; set EXAMPLE_HOME if Example Harness keeps its data elsewhere',
        },
        { name: 'Sample Harness', text: 'not found' },
      ],
      notes: [],
      canSync: true,
      isReloading: false,
    })
  })

  it('names a harness found with nothing in it by where it was found', () => {
    // Arrange
    record('ok')
    harness({ id: 'example', name: 'Example Harness', is_found: 1, location: '~/.example/data' })

    // Act
    const shown = state.firstRun()

    // Assert
    expect(shown?.harnesses).toStrictEqual([{ name: 'Example Harness', text: 'found at ~/.example/data' }])
  })

  it("shows a harness's problem after a partial sync, and the record's error under the list", () => {
    // Arrange
    record('partial', 'Sample Harness could not be read')
    harness({ id: 'example', name: 'Example Harness' })
    harness({ id: 'sample', name: 'Sample Harness', location: '~/.sample', problem: 'could not read ~/.sample' })

    // Act
    const shown = state.firstRun()

    // Assert
    expect(shown).toMatchObject({
      kind: 'sync-problems',
      headline: 'No agent data found yet.',
      harnesses: [
        { name: 'Example Harness', text: 'not found' },
        { name: 'Sample Harness', text: 'could not read ~/.sample' },
      ],
      notes: ['Sample Harness could not be read', RUN_IN_TERMINAL],
    })
  })

  it('shows a failed sync with its error, and a stopped or unfinished one without', () => {
    // Act
    const headlines = [
      ['failed', 'the disk is full', true],
      ['stopped', null, true],
      [null, null, false],
    ].map(([outcome, error, isEnded]) => {
      db.exec('DELETE FROM sync_run')
      record(outcome as string | null, error as string | null, isEnded as boolean)
      const shown = state.firstRun()
      return [shown?.kind, shown?.headline, shown?.notes]
    })

    // Assert
    expect(headlines).toStrictEqual([
      ['sync-failed', 'The last sync failed: the disk is full', [RUN_IN_TERMINAL]],
      ['sync-failed', 'The last sync did not finish.', [RUN_IN_TERMINAL]],
      ['sync-failed', 'The last sync did not finish.', [RUN_IN_TERMINAL]],
    ])
  })

  it('reads the newest record only', () => {
    // Arrange
    record('failed', 'the disk is full')
    record('ok')

    // Act
    const shown = state.firstRun()?.kind

    // Assert
    expect(shown).toBe('nothing-found')
  })

  it('says no sync has run when there is no record and no lock', () => {
    // Act
    const shown = state.firstRun()

    // Assert
    expect(shown).toMatchObject({ kind: 'never-synced', status: 200, headline: 'No sync has run yet.', canSync: true })
  })

  it('is nothing once a session exists, whatever the lock and the record say', () => {
    // Arrange
    holdLock('sync')
    record('failed', 'the disk is full')
    withSession()

    // Act
    const shown = state.firstRun()

    // Assert
    expect(shown).toBeNull()
  })
})

describe('a warehouse the app cannot read', () => {
  it('names both versions of a newer schema and offers no sync', () => {
    // Arrange
    db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION + 1)}`)

    // Act
    const shown = state.firstRun()

    // Assert
    expect(shown).toStrictEqual({
      kind: 'newer-schema',
      status: 503,
      headline: `This warehouse is at schema ${String(SCHEMA_VERSION + 1)}, which a newer Log Book wrote; this Log Book reads ${String(SCHEMA_VERSION)}. Stop it and start the newer one.`,
      harnesses: [],
      notes: [],
      canSync: false,
      isReloading: false,
    })
  })

  it('names both versions of an older schema, which a sync upgrades', () => {
    // Arrange
    db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION - 1)}`)

    // Act
    const shown = state.firstRun()

    // Assert
    expect(shown).toMatchObject({
      kind: 'older-schema',
      status: 503,
      headline: `This warehouse is at schema ${String(SCHEMA_VERSION - 1)}; Sync upgrades it to ${String(SCHEMA_VERSION)}.`,
      canSync: true,
    })
  })

  it('names the path of a missing warehouse, which a sync creates', async () => {
    // Arrange
    const missing = join(warehouse.path, '..', 'missing', 'warehouse.db')
    vi.stubEnv('LOGBOOK_DB', missing)
    vi.resetModules()
    const fresh = await import('./state')

    // Act
    const shown = fresh.firstRun()
    vi.stubEnv('LOGBOOK_DB', warehouse.path)

    // Assert
    expect(shown).toMatchObject({
      kind: 'no-warehouse',
      status: 503,
      headline: `There is no warehouse at ${missing} yet. Sync creates it.`,
      canSync: true,
    })
  })
})

describe('the Sync control', () => {
  const SYNC_TITLE = 'Import what changed since the last sync'
  // Four minutes after the test records end.
  const LATER = START + 1000 + 4 * MINUTE

  it.each([
    [
      'compact',
      'Compacting (since 2 min)',
      'logbook compact is rewriting the warehouse. Pages keep working; syncs and labelling wait until it ends. Stop it where it was started with Ctrl+C.',
    ],
    [
      'forget',
      'Forgetting sessions (since 2 min)',
      'logbook forget is removing sessions and rewriting the warehouse. Pages keep working; syncs and labelling wait until it ends.',
    ],
    ['sync', 'Syncing… (since 2 min)', SYNC_TITLE],
  ] as const)(
    'reads the lock held as %s over a record that never ended, never as a failed sync',
    (operation, label, title) => {
      // Arrange
      withSession()
      record(null, null, false)
      const startedAt = holdLock(operation)

      // Act
      const control = state.syncControl(startedAt + 2 * MINUTE)

      // Assert
      expect(control).toStrictEqual({ label, title, tone: 'slow', isRunning: true })
    }
  )

  it('says never synced while there is no record', () => {
    // Arrange
    withSession()

    // Act
    const control = state.syncControl(LATER)

    // Assert
    expect(control).toStrictEqual({ label: 'Never synced', title: SYNC_TITLE, tone: 'hollow', isRunning: false })
  })

  it('says when the last sync ended ok', () => {
    // Arrange
    withSession()
    record('ok')

    // Act
    const control = state.syncControl(LATER)

    // Assert
    expect(control).toStrictEqual({ label: 'Synced 4 min ago', title: SYNC_TITLE, tone: 'good', isRunning: false })
  })

  it("shows a partial sync's first problem on hover, over the data it imported", () => {
    // Arrange
    withSession()
    record('partial', 'Example Harness: cannot read ~/.example/data: permission denied')

    // Act
    const control = state.syncControl(LATER)

    // Assert
    expect(control).toStrictEqual({
      label: 'Synced 4 min ago, with problems',
      title: 'Example Harness: cannot read ~/.example/data: permission denied',
      tone: 'problem',
      isRunning: false,
    })
  })

  it('shows a failed sync with its error, a stopped one with the default title, and one that never ended as failed', () => {
    // Act
    const controls = [
      ['failed', 'the disk is full', true],
      ['stopped', null, true],
      [null, null, false],
    ].map(([outcome, error, isEnded]) => {
      db.exec('DELETE FROM sync_run')
      record(outcome as string | null, error as string | null, isEnded as boolean)
      return state.syncControl(LATER)
    })

    // Assert
    expect(controls).toStrictEqual([
      { label: 'Sync failed 4 min ago', title: 'the disk is full', tone: 'problem', isRunning: false },
      { label: 'Sync failed 4 min ago', title: SYNC_TITLE, tone: 'problem', isRunning: false },
      { label: 'Sync failed 4 min ago', title: SYNC_TITLE, tone: 'problem', isRunning: false },
    ])
  })
})
