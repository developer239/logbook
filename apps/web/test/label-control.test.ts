import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { SCHEMA_VERSION, takeLabelsLock, type IHeldLock, type LabelsLockOperation } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountBuiltHandler, type IBuiltHandler } from './built-handler'

const MINUTE = 60_000
const LABEL_TITLE =
  'See what labelling would send, then start it. Labelling runs your own Claude Code and uses your Claude plan.'
const SESSION = {
  id: 'example:demo-0001',
  harness: 'example',
  source_id: 'demo-0001',
  origin: 'interactive',
  is_scripted: 0,
  title: 'Rename the release script',
  started_at: 1_791_100_800_000,
  ended_at: 1_791_100_860_000,
}

let warehouse: ITestWarehouse
let built: IBuiltHandler
// A process the test keeps alive, so a lock that names it is held.
let holder: ChildProcess
let holderPid = 0
let held: IHeldLock | undefined

interface IRunRow {
  pid?: number
  endedAgo?: number | null
  outcome?: string | null
  error?: string | null
}

// A run record that started 15 minutes before the request and ended `endedAgo` before it, with progress.
const runRecord = ({ pid = 999_999, endedAgo = null, outcome = null, error = null }: IRunRow = {}): void => {
  const now = Date.now()
  insert(warehouse.db, 'label_run', {
    pid,
    started_at: now - 15 * MINUTE,
    ended_at: endedAgo === null ? null : now - endedAgo,
    outcome,
    error,
    model: 'claude-haiku-4-5',
  })
  const { id } = warehouse.db.prepare('SELECT MAX(id) AS id FROM label_run').get() as { id: number }
  insert(warehouse.db, 'label_run_task', { run_id: id, task: 'shell', version: 1, planned: 2214, done: 1240 })
}

// The lock as the process the test keeps alive holds it, taken two minutes before the request.
const lock = (operation: LabelsLockOperation): void => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() - 2 * MINUTE)
  try {
    held = takeLabelsLock(warehouse.path, operation, { pid: holderPid })
  } finally {
    vi.useRealTimers()
  }
}

// The top bar's Label control as the page renders it, or null where the page has none.
const control = async (): Promise<Record<string, unknown> | null> => {
  const body = await (await fetch(`${built.origin}/conversations`)).text()
  const shown = /<p[^>]*data-label-control[^>]*>(?<inner>[\s\S]*?)<\/p>/u.exec(body)?.groups?.inner
  if (shown === undefined) {
    return null
  }
  const text = /class="top-bar__label-text"(?<attributes>[^>]*)>(?<text>[^<]*)</u.exec(shown)?.groups
  const link = /<a[^>]*href="(?<href>[^"]*)"[^>]*title="(?<title>[^"]*)"[^>]*>(?<word>[^<]*)</u.exec(shown)?.groups
  return {
    text: text?.text?.trim(),
    title: /title="(?<title>[^"]*)"/u.exec(text?.attributes ?? '')?.groups?.title ?? null,
    link: link === undefined ? null : { word: link.word?.trim(), href: link.href, title: link.title },
    tone: /status--(?<tone>[a-z]+)/u.exec(shown)?.groups?.tone,
    hasForm: shown.includes('<form'),
  }
}

beforeAll(async () => {
  warehouse = await createTestWarehouse()
  insert(warehouse.db, 'session', SESSION)
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
  warehouse.db.exec(
    `DELETE FROM label_run_task; DELETE FROM label_run; PRAGMA user_version = ${String(SCHEMA_VERSION)}`
  )
  warehouse.db.exec('DELETE FROM session')
  insert(warehouse.db, 'session', SESSION)
})

afterAll(async () => {
  const exited = once(holder, 'exit')
  holder.kill()
  await exited
  await built.close()
  vi.unstubAllEnvs()
  await warehouse.remove()
})

const LABEL = { word: 'Label', href: '/labels', title: LABEL_TITLE }
const VIEW = { word: 'View', href: '/labels', title: 'Show labelling progress.' }

describe('the Label control in the built handler', () => {
  it.each([
    ['never', (): void => undefined, 'Not labelled yet', null, LABEL, 'hollow'],
    [
      'finished',
      (): void => {
        runRecord({ endedAgo: 12 * MINUTE, outcome: 'ok' })
      },
      'Labelled 12 min ago',
      null,
      LABEL,
      'good',
    ],
    [
      'stopped',
      (): void => {
        runRecord({ endedAgo: 3 * MINUTE, outcome: 'stopped' })
      },
      'Labelling stopped 3 min ago. Label continues where it stopped.',
      null,
      LABEL,
      'hollow',
    ],
    [
      'interrupted',
      (): void => {
        runRecord()
      },
      'Labelling was interrupted 15 min ago. Label continues where it stopped.',
      null,
      LABEL,
      'hollow',
    ],
    [
      'limit',
      (): void => {
        runRecord({ endedAgo: 20 * MINUTE, outcome: 'limit' })
      },
      'Stopped at your Claude usage limit 20 min ago. Label again once it resets; finished batches are kept.',
      null,
      LABEL,
      'slow',
    ],
    [
      'unreachable',
      (): void => {
        runRecord({ endedAgo: 6 * MINUTE, outcome: 'unreachable' })
      },
      'Labelling stopped 6 min ago: Claude Code could not reach its API. Label again when you are online.',
      null,
      LABEL,
      'problem',
    ],
    [
      'failed',
      (): void => {
        runRecord({ endedAgo: 5 * MINUTE, outcome: 'failed', error: 'the disk is full' })
      },
      'Labelling failed 5 min ago',
      'the disk is full',
      { ...LABEL, word: 'Label again' },
      'problem',
    ],
    [
      'running-elsewhere with progress',
      (): void => {
        lock('labels')
        runRecord({ pid: holderPid })
      },
      'Labelling in a terminal since 2 min: 1,240 of 2,214 records. Stop it there with Ctrl+C.',
      null,
      VIEW,
      'slow',
    ],
    [
      'running-elsewhere without a record',
      (): void => {
        lock('labels')
      },
      'Labelling in a terminal since 2 min. Stop it there with Ctrl+C.',
      null,
      VIEW,
      'slow',
    ],
    [
      'maintenance by compact',
      (): void => {
        lock('compact')
      },
      'Labelling waits: logbook compact is rewriting the warehouse (since 2 min).',
      null,
      null,
      'slow',
    ],
    [
      'maintenance by forget',
      (): void => {
        lock('forget')
      },
      'Labelling waits: logbook forget is removing sessions (since 2 min).',
      null,
      null,
      'slow',
    ],
  ] as const)('reads %s', async (_name, arrange, text, title, link, tone) => {
    // Arrange
    arrange()

    // Act
    const shown = await control()

    // Assert
    expect(shown).toStrictEqual({ text, title, link, tone, hasForm: false })
  })

  it('is absent while the warehouse has no session and for a newer schema', async () => {
    // Arrange
    warehouse.db.exec('DELETE FROM session')

    // Act
    const withoutSessions = await control()
    insert(warehouse.db, 'session', SESSION)
    warehouse.db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION + 1)}`)
    const newer = await control()

    // Assert
    expect([withoutSessions, newer]).toStrictEqual([null, null])
  })
})
