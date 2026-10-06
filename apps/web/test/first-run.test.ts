import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { SCHEMA_VERSION, takeSyncLock, type IHeldLock } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountBuiltHandler, type IBuiltHandler } from './built-handler'

const AT = Date.UTC(2026, 9, 5, 12)
// Every page of the app; none of them can read a warehouse that has no session.
const PAGES = ['/', '/conversations', '/conversations/example%3Ademo-0001', '/steps', '/tokens']
const PANE = '/pane/example%3Ademo-0001?turn=example%3Ademo-0001%2Fm1'
const REFRESH = '<meta http-equiv="refresh" content="5">'

let warehouse: ITestWarehouse
let built: IBuiltHandler
// A process the test keeps alive, so a lock that names it is held.
let holder: ChildProcess
let holderPid = 0
let held: IHeldLock | undefined

const record = (outcome: string): void => {
  insert(warehouse.db, 'sync_run', { started_at: AT, ended_at: AT + 1000, outcome, error: 'the disk is full' })
}

// Each state as the warehouse and the sync lock make it.
const STATES = {
  'never-synced': { status: 200, arrange: (): void => undefined },
  'first-sync': {
    status: 200,
    arrange: (): void => {
      held = takeSyncLock(warehouse.path, 'sync', { pid: holderPid })
    },
  },
  'nothing-found': {
    status: 200,
    arrange: (): void => {
      record('ok')
      insert(warehouse.db, 'harness', {
        id: 'example',
        name: 'Example Harness',
        default_agent: 'helper',
        filter_alias: 'ex',
        is_found: 0,
        checked_at: AT,
        location: '~/.example/data',
        location_variables: '["EXAMPLE_HOME"]',
      })
    },
  },
  'sync-problems': { status: 200, arrange: (): void => record('partial') },
  'sync-failed': { status: 200, arrange: (): void => record('failed') },
  'older-schema': {
    status: 503,
    arrange: (): void => warehouse.db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION - 1)}`),
  },
  'newer-schema': {
    status: 503,
    arrange: (): void => warehouse.db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION + 1)}`),
  },
} as const

const fetchPage = async (origin: string, path: string): Promise<{ status: number; body: string }> => {
  const response = await fetch(`${origin}${path}`)
  return { status: response.status, body: await response.text() }
}

// What every page answers in one state: its status, the panel it shows, whether it reloads and offers Sync.
const pagesIn = async (origin: string): Promise<unknown[]> =>
  Promise.all(
    PAGES.map(async (path) => {
      const { status, body } = await fetchPage(origin, path)
      return {
        path,
        status,
        panel: /data-first-run="(?<kind>[^"]+)"/u.exec(body)?.groups?.kind,
        isReloading: body.includes(REFRESH),
        canSync: body.includes('action="/sync"'),
      }
    })
  )

beforeAll(async () => {
  warehouse = await createTestWarehouse()
  vi.stubEnv('LOGBOOK_DB', warehouse.path)
  built = await mountBuiltHandler()
  holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
  if (holder.pid === undefined) {
    throw new Error('The process that holds the test locks did not start')
  }
  holderPid = holder.pid
})

afterEach(() => {
  held?.release()
  held = undefined
  warehouse.db.exec(`DELETE FROM sync_run; DELETE FROM harness; PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
})

afterAll(async () => {
  const exited = once(holder, 'exit')
  holder.kill()
  await exited
  await built.close()
  vi.unstubAllEnvs()
  await warehouse.remove()
})

describe('first-run panels in the built handler', () => {
  it.each(Object.entries(STATES))('shows the %s panel on every page, with its status', async (kind, state) => {
    // Arrange
    state.arrange()

    // Act
    const [pages, pane] = [await pagesIn(built.origin), await fetchPage(built.origin, PANE)]

    // Assert
    expect({ pages, pane: pane.status }).toStrictEqual({
      pages: PAGES.map((path) => ({
        path,
        status: state.status,
        panel: kind,
        isReloading: kind === 'first-sync',
        canSync: kind !== 'newer-schema',
      })),
      pane: state.status,
    })
  })

  it('names a harness that was not found, where it looked and the variable that points it elsewhere', async () => {
    // Arrange
    STATES['nothing-found'].arrange()

    // Act
    const { body } = await fetchPage(built.origin, '/conversations')

    // Assert
    expect({
      headline: body.includes('No agent data found yet.'),
      line: /Example Harness<\/b>\s*<span>not found at ~\/.example\/data; set EXAMPLE_HOME if Example Harness keeps its data elsewhere<\/span>/u.test(
        body
      ),
    }).toStrictEqual({ headline: true, line: true })
  })

  it("shows a harness's notice holding markup as text, directly after the harness's line", async () => {
    // Arrange
    record('ok')
    insert(warehouse.db, 'harness', {
      id: 'example',
      name: 'Example Harness',
      default_agent: 'helper',
      filter_alias: 'ex',
      is_found: 1,
      checked_at: AT,
      location: '~/.example/data',
      location_variables: '[]',
      notice: '<img src=x>',
    })

    // Act
    const { body } = await fetchPage(built.origin, '/')

    // Assert
    expect(body).toMatch(
      /Example Harness<\/b>\s*<span>found at ~\/.example\/data<\/span>\s*<span class="first-run__notice">&lt;img src=x&gt;<\/span>/u
    )
  })

  it('shows the missing warehouse panel, with its path, on every page of an app that never opened one', async () => {
    // Arrange
    const missing = join(warehouse.path, '..', 'missing', 'warehouse.db')
    vi.stubEnv('LOGBOOK_DB', missing)
    const fresh = await mountBuiltHandler()

    // Act
    const [pages, home] = [await pagesIn(fresh.origin), await fetchPage(fresh.origin, '/')]
    await fresh.close()
    vi.stubEnv('LOGBOOK_DB', warehouse.path)

    // Assert
    expect({
      pages,
      hasPath: home.body.includes(`There is no warehouse at ${missing} yet. Sync creates it.`),
    }).toStrictEqual({
      pages: PAGES.map((path) => ({ path, status: 503, panel: 'no-warehouse', isReloading: false, canSync: true })),
      hasPath: true,
    })
  })
})
