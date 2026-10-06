import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { SYNC_TIMEOUT_MS } from '@log-book/engine'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IChildRegistry } from './child-registry.js'
import {
  createHostSyncs,
  createProgressView,
  firstSyncLines,
  REDRAW_MS,
  scheduledSyncLine,
  type IHostSyncs,
  type ISyncEnd,
} from './host-sync.js'
import type { SyncMessage } from './sync.js'

const HOME = '/home/example'
const LOG = '/home/example/.local/share/log-book/logs/sync-2026-10-04T14-40-00.log'
const SHOWN_LOG = '~/.local/share/log-book/logs/sync-2026-10-04T14-40-00.log'
const PROBLEM = 'Claude Code: 1 transcript could not be read: example.jsonl: unexpected end of input'
const AT = new Date(2026, 9, 4, 14, 40)

const done = (imported: number, problems: string[] = []): Extract<SyncMessage, { type: 'done' }> => ({
  type: 'done',
  imported,
  unchanged: 0,
  ms: 1400,
  problems,
})

const end = (fields: Partial<ISyncEnd>): ISyncEnd => ({
  code: 0,
  signal: null,
  isTimedOut: false,
  done: done(0),
  lastLine: '',
  log: LOG,
  ...fields,
})

const progress = (adapter: string, count: number, total: number, reread = false): SyncMessage => ({
  type: 'progress',
  adapter,
  done: count,
  total,
  reread,
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createProgressView', () => {
  it('writes a line at the first unit, every tenth and the last off a terminal, and the re-read and deriving lines', () => {
    // Arrange
    const written: string[] = []
    const view = createProgressView({ write: (text) => written.push(text), isTty: false, now: () => 0 })

    // Act
    for (let count = 1; count <= 20; count += 1) {
      view.onMessage(progress('claude-code', count, 20, count < 20))
    }
    view.onMessage({ type: 'phase', name: 'derivations' })

    // Assert
    expect(written.join('')).toBe(
      [
        '  Claude Code  re-reading all transcripts (parser updated)',
        ...[2, 4, 6, 8, 10, 12, 14, 16, 18].map(() => '  Claude Code  re-reading all transcripts (parser updated)'),
        '  Claude Code  20 of 20 transcripts',
        '  Deriving     turns, commands, links, rules-based labels',
        '',
      ].join('\n')
    )
  })

  it('names each adapter by its descriptor and its unit word', () => {
    // Arrange
    const written: string[] = []
    const view = createProgressView({ write: (text) => written.push(text), isTty: false, now: () => 0 })

    // Act
    view.onMessage(progress('opencode', 598, 598))

    // Assert
    expect(written).toStrictEqual(['  OpenCode     598 of 598 sessions\n'])
  })

  it('redraws the block on a terminal at most once every 200 ms, and once more at the end', () => {
    // Arrange
    const written: string[] = []
    let now = 0
    const view = createProgressView({ write: (text) => written.push(text), isTty: true, now: () => now })

    // Act
    for (let count = 1; count <= 10; count += 1) {
      view.onMessage(progress('claude-code', count, 10))
      now += REDRAW_MS / 4
    }
    view.finish()

    // Assert
    expect({
      redraws: written.length,
      last: written.at(-1),
    }).toStrictEqual({
      redraws: 4,
      last: '\u001B[1A\u001B[2K  Claude Code  10 of 10 transcripts\n',
    })
  })
})

describe('firstSyncLines', () => {
  it('says how long it took, how many sessions it brought and when the next sync runs', () => {
    // Act
    const lines = firstSyncLines(end({ done: { ...done(1010), ms: 31_000 } }), 5, HOME)

    // Assert
    expect(lines).toStrictEqual(['First sync   done in 31 s: 1,010 sessions. Next sync in 5 minutes.'])
  })

  it('names the first problem and the log of a partial first sync', () => {
    // Act
    const lines = firstSyncLines(end({ code: 10, done: { ...done(1010, [PROBLEM]), ms: 31_000 } }), 5, HOME)

    // Assert
    expect(lines).toStrictEqual([
      `First sync   done in 31 s: 1,010 sessions, with 1 problem: ${PROBLEM}`,
      `             Full output: ${SHOWN_LOG}`,
    ])
  })
})

describe('scheduledSyncLine', () => {
  it('names an import with the local time', () => {
    // Act
    const text = scheduledSyncLine(end({ done: done(3) }), AT, HOME)

    // Assert
    expect(text).toBe('14:40 sync: 3 sessions updated in 1.4 s')
  })

  it('names a problem and the log', () => {
    // Act
    const text = scheduledSyncLine(end({ code: 10, done: done(3, [PROBLEM]) }), AT, HOME)

    // Assert
    expect(text).toBe(`14:40 sync: 3 sessions updated in 1.4 s, with 1 problem: ${PROBLEM}. Full output: ${SHOWN_LOG}`)
  })

  it('names a failure by its exit code and its last stderr line', () => {
    // Act
    const text = scheduledSyncLine(end({ code: 1, done: null, lastLine: 'The disk is full.' }), AT, HOME)

    // Assert
    expect(text).toBe(`14:40 sync failed (exit 1): The disk is full. Full output: ${SHOWN_LOG}`)
  })

  it('says nothing for a sync that imported nothing, or that another sync held off', () => {
    // Act
    const texts = [scheduledSyncLine(end({}), AT, HOME), scheduledSyncLine(end({ code: 3, done: null }), AT, HOME)]

    // Assert
    expect(texts).toStrictEqual([null, null])
  })

  it('tells the user to restart after an update while running', () => {
    // Act
    const text = scheduledSyncLine(end({ code: 9, done: null }), AT, HOME)

    // Assert
    expect(text).toBe('Log Book was updated while running. Press Ctrl+C and start logbook again.')
  })
})

interface IFakeSync {
  child: EventEmitter & { stderr: EventEmitter }
  terminated: boolean
}

// A registry whose sync children end only when the test ends them.
const fakeRegistry = (): { registry: IChildRegistry; syncs: IFakeSync[] } => {
  const syncs: IFakeSync[] = []
  const registry: IChildRegistry = {
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
      syncs.push({ child, terminated: false })
      return child as unknown as ChildProcess
    },
    logOf: () => LOG,
    terminate: async (child) => {
      const sync = syncs.find((candidate) => candidate.child === (child as unknown))
      if (sync !== undefined) {
        sync.terminated = true
        sync.child.emit('close', null, 'SIGTERM')
      }
      return Promise.resolve()
    },
    stop: async () => Promise.resolve(),
    kill: () => undefined,
  }
  return { registry, syncs }
}

const finish = (sync: IFakeSync | undefined, code: number, message: SyncMessage | null = done(0)): void => {
  if (message !== null) {
    sync?.child.emit('message', message)
  }
  sync?.child.emit('close', code, null)
}

const MINUTE_MS = 60_000

// Host syncs whose first sync has ended.
const started = async (written: string[]): Promise<{ hostSyncs: IHostSyncs; syncs: IFakeSync[] }> => {
  const { registry, syncs } = fakeRegistry()
  const hostSyncs = createHostSyncs({
    children: registry,
    intervalMinutes: 5,
    home: HOME,
    stdout: (text) => written.push(text),
    progress: { write: () => undefined, isTty: false, now: () => 0 },
    now: () => AT,
  })
  const first = hostSyncs.start()
  finish(syncs[0], 0)
  await first
  return { hostSyncs, syncs }
}

describe('createHostSyncs', () => {
  it('runs a sync every interval once the first has ended', async () => {
    // Arrange
    vi.useFakeTimers()
    const { hostSyncs, syncs } = await started([])

    // Act
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS)
    finish(syncs[1], 0)
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS)
    hostSyncs.stop()

    // Assert
    expect(syncs).toHaveLength(3)
  })

  it('skips a tick while a sync runs', async () => {
    // Arrange
    vi.useFakeTimers()
    const { hostSyncs, syncs } = await started([])

    // Act
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS)
    hostSyncs.stop()

    // Assert
    expect(syncs).toHaveLength(2)
  })

  it('skips a sync another sync held off without a line', async () => {
    // Arrange
    vi.useFakeTimers()
    const written: string[] = []
    const { hostSyncs, syncs } = await started(written)
    written.length = 0

    // Act
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS)
    finish(syncs[1], 3, null)
    await vi.advanceTimersByTimeAsync(0)
    hostSyncs.stop()

    // Assert
    expect(written).toStrictEqual([])
  })

  it('stops a sync that runs past the timeout and reports it failed', async () => {
    // Arrange
    vi.useFakeTimers()
    const written: string[] = []
    const { hostSyncs, syncs } = await started(written)
    written.length = 0

    // Act
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS)
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUT_MS)
    hostSyncs.stop()

    // Assert
    expect({ terminated: syncs[1]?.terminated, written }).toStrictEqual({
      terminated: true,
      written: [`14:40 sync failed (stopped after 30 min). Full output: ${SHOWN_LOG}\n`],
    })
  })
})
