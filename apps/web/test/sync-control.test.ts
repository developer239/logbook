import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { takeSyncLock, type IHeldLock } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountBuiltHandler, type IBuiltHandler } from './built-handler'

const SYNC_TITLE = 'Import what changed since the last sync'
const MINUTE = 60_000

let warehouse: ITestWarehouse
let built: IBuiltHandler
// A process the test keeps alive, so a lock that names it is held.
let holder: ChildProcess
let holderPid = 0
let held: IHeldLock | undefined

// A record that ended five minutes before the request, or started then and never ended.
const record = (outcome: string | null, error: string | null, isEnded = true): void => {
  const at = Date.now() - 5 * MINUTE
  insert(warehouse.db, 'sync_run', { started_at: at - 1000, ended_at: isEnded ? at : null, outcome, error })
}

// The top bar's Sync control as the page renders it.
const control = async (): Promise<Record<string, unknown>> => {
  const body = await (await fetch(`${built.origin}/conversations`)).text()
  const button = /<button[^>]*class="[^"]*top-bar__sync-button[^"]*"[^>]*>[\s\S]*?<\/button>/u.exec(body)?.[0] ?? ''
  return {
    label: /data-sync-label[^>]*>(?<label>[^<]*)</u.exec(button)?.groups?.label,
    title: /title="(?<title>[^"]*)"/u.exec(button)?.groups?.title,
    tone: /status--(?<tone>[a-z]+)/u.exec(button)?.groups?.tone,
    isDisabled: /<button[^>]*\sdisabled/u.test(button),
  }
}

beforeAll(async () => {
  warehouse = await createTestWarehouse()
  insert(warehouse.db, 'session', {
    id: 'example:demo-0001',
    harness: 'example',
    source_id: 'demo-0001',
    origin: 'interactive',
    is_scripted: 0,
    title: 'Rename the release script',
    started_at: 1_791_100_800_000,
    ended_at: 1_791_100_860_000,
  })
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
  warehouse.db.exec('DELETE FROM sync_run')
})

afterAll(async () => {
  const exited = once(holder, 'exit')
  holder.kill()
  await exited
  await built.close()
  vi.unstubAllEnvs()
  await warehouse.remove()
})

describe('the Sync control in the built handler', () => {
  it('reads never synced with no record', async () => {
    // Act
    const shown = await control()

    // Assert
    expect(shown).toStrictEqual({ label: 'Never synced', title: SYNC_TITLE, tone: 'hollow', isDisabled: false })
  })

  it('reads a sync that ended ok', async () => {
    // Arrange
    record('ok', null)

    // Act
    const shown = await control()

    // Assert
    expect(shown).toStrictEqual({ label: 'Synced 5 min ago', title: SYNC_TITLE, tone: 'good', isDisabled: false })
  })

  it('reads a partial sync with its problem on hover', async () => {
    // Arrange
    record('partial', 'Example Harness: cannot read ~/.example/data: permission denied')

    // Act
    const shown = await control()

    // Assert
    expect(shown).toStrictEqual({
      label: 'Synced 5 min ago, with problems',
      title: 'Example Harness: cannot read ~/.example/data: permission denied',
      tone: 'problem',
      isDisabled: false,
    })
  })

  it('reads a failed sync with its error, enabled to retry', async () => {
    // Arrange
    record('failed', 'the disk is full')

    // Act
    const shown = await control()

    // Assert
    expect(shown).toStrictEqual({
      label: 'Sync failed 5 min ago',
      title: 'the disk is full',
      tone: 'problem',
      isDisabled: false,
    })
  })

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
  ] as const)('reads the lock held as %s, with the button disabled', async (operation, label, title) => {
    // Arrange
    record(null, null, false)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() - 2 * MINUTE)
    try {
      held = takeSyncLock(warehouse.path, operation, { pid: holderPid })
    } finally {
      vi.useRealTimers()
    }

    // Act
    const shown = await control()

    // Assert
    expect(shown).toStrictEqual({ label, title, tone: 'slow', isDisabled: true })
  })
})
