import type { ChildProcess } from 'node:child_process'
import { SYNC_TIMEOUT_MS } from '@log-book/warehouse'
import type { IChildRegistry } from './child-registry.js'
import { exitCodeOf } from './errors.js'
import { formatCount, formatDuration, tildePath } from './format.js'
import { ADAPTERS } from './grammar.js'
import type { SyncMessage } from './sync.js'

type TDone = Extract<SyncMessage, { type: 'done' }>

// How one sync child ended: its exit code, or the signal that ended it, what it reported, its last stderr line and its
// log.
export interface ISyncEnd {
  code: number | null
  signal: string | null
  isTimedOut: boolean
  done: TDone | null
  lastLine: string
  log: string
}

// The host's column: labels padded to it, values after.
const COLUMN = 13
// A redraw of the progress block on a terminal comes at most this often.
export const REDRAW_MS = 200
const TENTHS = 10
const MINUTE_MS = 60_000

const line = (text: string): string => `${text}\n`

const plural = (count: number, one: string, many: string): string => `${formatCount(count)} ${count === 1 ? one : many}`

const descriptorOf = (adapterId: string): { name: string; unitNoun: string } => {
  const found = ADAPTERS.find(({ descriptor }) => descriptor.id === adapterId)
  if (found === undefined) {
    throw new Error(`No registered adapter has the id ${adapterId}`)
  }
  return found.descriptor
}

const isSyncMessage = (value: unknown): value is SyncMessage =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  (value.type === 'progress' || value.type === 'phase' || value.type === 'done')

const lastLineOf = (text: string): string =>
  text
    .split('\n')
    .map((part) => part.trim())
    .findLast((part) => part !== '') ?? ''

// Runs `logbook sync` through the registry, with a channel for its progress, and stops it like a child on host stop
// once it has run for the engine's sync timeout.
const runSyncChild = async (children: IChildRegistry, onMessage: (message: SyncMessage) => void): Promise<ISyncEnd> => {
  const child: ChildProcess = children.spawn(['sync'], { hasChannel: true })
  const log = children.logOf(child)
  if (log === null) {
    throw new Error("The host's registry wrote no log for a sync child")
  }
  let stderr = ''
  let done: TDone | null = null
  let isTimedOut = false
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4096)
  })
  child.on('message', (message: unknown) => {
    if (!isSyncMessage(message)) {
      return
    }
    if (message.type === 'done') {
      done = message
    }
    onMessage(message)
  })
  const timer = setTimeout(() => {
    isTimedOut = true
    void children.terminate(child)
  }, SYNC_TIMEOUT_MS)
  return new Promise((resolve) => {
    child.once('close', (code: number | null, signal: string | null) => {
      clearTimeout(timer)
      resolve({ code, signal, isTimedOut, done, lastLine: lastLineOf(stderr), log })
    })
  })
}

interface IAdapterProgress {
  name: string
  unitNoun: string
  done: number
  total: number
  isRereading: boolean
  tenth: number
}

const progressText = (adapter: IAdapterProgress): string =>
  adapter.isRereading && adapter.done < adapter.total
    ? `re-reading all ${adapter.unitNoun} (parser updated)`
    : `${formatCount(adapter.done)} of ${formatCount(adapter.total)} ${adapter.unitNoun}`

const DERIVING = `  ${'Deriving'.padEnd(COLUMN)}turns, commands, links, rules-based labels`

export interface IProgressOutput {
  write: (text: string) => void
  isTty: boolean
  now: () => number
}

interface IProgressView {
  onMessage: (message: SyncMessage) => void
  // The block as it ended, drawn once more on a terminal.
  finish: () => void
}

// The first sync's progress: on a terminal one line per adapter, redrawn in place at most every REDRAW_MS; elsewhere a
// line at an adapter's first unit, every tenth and its last, and once when it starts re-reading.
export const createProgressView = ({ write, isTty, now }: IProgressOutput): IProgressView => {
  const adapters = new Map<string, IAdapterProgress>()
  let isDeriving = false
  let drawnLines = 0
  let drawnAt = Number.NEGATIVE_INFINITY

  const blockLines = (): string[] => [
    ...[...adapters.values()].map((adapter) => `  ${adapter.name.padEnd(COLUMN)}${progressText(adapter)}`),
    ...(isDeriving ? [DERIVING] : []),
  ]

  const draw = (): void => {
    const up = drawnLines === 0 ? '' : `\u001B[${String(drawnLines)}A`
    const lines = blockLines()
    write(`${up}${lines.map((text) => `\u001B[2K${text}\n`).join('')}`)
    drawnLines = lines.length
    drawnAt = now()
  }

  return {
    onMessage: (message: SyncMessage): void => {
      if (message.type === 'done') {
        return
      }
      if (message.type === 'phase') {
        isDeriving = true
        if (!isTty) {
          write(line(DERIVING))
        }
      } else {
        const known = adapters.get(message.adapter)
        const adapter = known ?? { ...descriptorOf(message.adapter), done: 0, total: 0, isRereading: false, tenth: -1 }
        const isNewReread = message.reread && !adapter.isRereading
        Object.assign(adapter, { done: message.done, total: message.total, isRereading: message.reread })
        adapters.set(message.adapter, adapter)
        const tenth = Math.floor((message.done * TENTHS) / message.total)
        if (!isTty && (isNewReread || tenth !== adapter.tenth || message.done === message.total)) {
          adapter.tenth = tenth
          write(line(`  ${adapter.name.padEnd(COLUMN)}${progressText(adapter)}`))
        }
      }
      if (isTty && now() - drawnAt >= REDRAW_MS) {
        draw()
      }
    },
    finish: (): void => {
      if (isTty && (adapters.size > 0 || isDeriving)) {
        draw()
      }
    },
  }
}

const minutesText = (intervalMinutes: number): string => plural(intervalMinutes, 'minute', 'minutes')

const problemsText = (problems: readonly string[]): string => {
  const [first] = problems
  if (first === undefined) {
    throw new Error('A partial sync reported no problem')
  }
  return `${plural(problems.length, 'problem', 'problems')}: ${first}`
}

const UPDATED_WHILE_RUNNING = 'Log Book was updated while running. Press Ctrl+C and start logbook again.'

const failureText = (end: ISyncEnd): string => {
  if (end.isTimedOut) {
    return `failed (stopped after ${formatDuration(SYNC_TIMEOUT_MS)})`
  }
  // The line's own full stop gives way to the one that ends the sentence.
  const reason = end.lastLine.replace(/\.$/u, '')
  return end.code === null ? `failed (ended by ${String(end.signal)})` : `failed (exit ${String(end.code)}): ${reason}`
}

const failedLine = (prefix: string, end: ISyncEnd, home: string): string =>
  `${prefix}${failureText(end)}. Full output: ${tildePath(end.log, home)}`

// What the first sync ends with: done, plain or partial; skipped when a sync already runs; or failed.
export const firstSyncLines = (end: ISyncEnd, intervalMinutes: number, home: string): string[] => {
  const head = 'First sync'.padEnd(COLUMN)
  if (end.code === exitCodeOf('updated while running')) {
    return [UPDATED_WHILE_RUNNING]
  }
  if (end.code === exitCodeOf('already running')) {
    return [`${head}skipped: ${end.lastLine}`]
  }
  const isPartial = end.code === exitCodeOf('partial failure')
  if ((end.code !== exitCodeOf('success') && !isPartial) || end.done === null) {
    return [failedLine(head, end, home)]
  }
  const done = `${head}done in ${formatDuration(end.done.ms)}: ${plural(end.done.imported, 'session', 'sessions')}`
  if (!isPartial) {
    return [`${done}. Next sync in ${minutesText(intervalMinutes)}.`]
  }
  return [
    `${done}, with ${problemsText(end.done.problems)}`,
    `${' '.repeat(COLUMN)}Full output: ${tildePath(end.log, home)}`,
  ]
}

const twoDigits = (value: number): string => String(value).padStart(2, '0')

const clockOf = (at: Date): string => `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`

// The line a scheduled sync leaves, or null: only a sync that imported something, met a problem or failed speaks.
export const scheduledSyncLine = (end: ISyncEnd, at: Date, home: string): string | null => {
  if (end.code === exitCodeOf('already running')) {
    return null
  }
  if (end.code === exitCodeOf('updated while running')) {
    return UPDATED_WHILE_RUNNING
  }
  const time = clockOf(at)
  const isPartial = end.code === exitCodeOf('partial failure')
  if ((end.code !== exitCodeOf('success') && !isPartial) || end.done === null) {
    return failedLine(`${time} sync `, end, home)
  }
  if (!isPartial && end.done.imported === 0) {
    return null
  }
  const updated = `${time} sync: ${plural(end.done.imported, 'session', 'sessions')} updated in ${formatDuration(end.done.ms)}`
  return isPartial
    ? `${updated}, with ${problemsText(end.done.problems)}. Full output: ${tildePath(end.log, home)}`
    : updated
}

export interface IHostSyncOptions {
  children: IChildRegistry
  intervalMinutes: number
  home: string
  stdout: (text: string) => void
  progress: IProgressOutput
  now?: () => Date
}

export interface IHostSyncs {
  isSyncing: () => boolean
  // The first sync, then the schedule, which starts when the first sync has ended.
  start: () => Promise<void>
  // No more syncs, and no line from one the stop ends.
  stop: () => void
}

// The host's syncs: the first one, then one every interval until stopped, skipped while one runs.
export const createHostSyncs = ({
  children,
  intervalMinutes,
  home,
  stdout,
  progress,
  now = () => new Date(),
}: IHostSyncOptions): IHostSyncs => {
  let isSyncing = false
  let isStopped = false
  let timer: ReturnType<typeof setInterval> | null = null

  // A sync the stop ended says nothing.
  const say = (text: string): void => {
    if (!isStopped) {
      stdout(line(text))
    }
  }

  const scheduled = async (): Promise<void> => {
    isSyncing = true
    try {
      const end = await runSyncChild(children, () => undefined)
      const text = scheduledSyncLine(end, now(), home)
      if (text !== null) {
        say(text)
      }
    } finally {
      isSyncing = false
    }
  }

  const tick = (): void => {
    if (!isSyncing) {
      void scheduled()
    }
  }

  return {
    isSyncing: (): boolean => isSyncing,
    start: async (): Promise<void> => {
      isSyncing = true
      say(`${'First sync'.padEnd(COLUMN)}reading your whole history (about half a minute per thousand sessions)`)
      const view = createProgressView(progress)
      try {
        const end = await runSyncChild(children, view.onMessage)
        view.finish()
        for (const text of firstSyncLines(end, intervalMinutes, home)) {
          say(text)
        }
      } finally {
        isSyncing = false
      }
      if (!isStopped) {
        timer = setInterval(tick, intervalMinutes * MINUTE_MS)
      }
    },
    stop: (): void => {
      isStopped = true
      if (timer !== null) {
        clearInterval(timer)
      }
    },
  }
}
