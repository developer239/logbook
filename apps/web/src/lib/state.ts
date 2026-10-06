import {
  readSyncLock,
  resolveWarehousePath,
  SCHEMA_VERSION,
  type SyncLockOperation,
  type SyncOutcome,
} from '@log-book/warehouse'
import { ago, elapsed, plural } from './format'
import { harnessesOf, type IHarness } from './queries/harnesses'
import { get, unreadable } from './warehouse'

export type FirstRunKind =
  | 'no-warehouse'
  | 'newer-schema'
  | 'older-schema'
  | 'first-sync'
  | 'nothing-found'
  | 'sync-problems'
  | 'sync-failed'
  | 'never-synced'

// A harness descriptor's display name, then what discovery found for it.
export interface IHarnessLine {
  name: string
  text: string
}

// What every page shows in its place while the warehouse has nothing to show, with the one action that moves on.
export interface IFirstRun {
  kind: FirstRunKind
  status: 200 | 503
  headline: string
  harnesses: IHarnessLine[]
  // The sentences under the harness lines.
  notes: string[]
  // A sync would run the same build that refuses a newer warehouse, so that state offers none.
  canSync: boolean
  // Only while the first sync runs: the page reloads itself, and the first session to land shows the page.
  isReloading: boolean
}

interface ISyncRecord {
  startedAt: number
  endedAt: number | null
  outcome: SyncOutcome | null
  error: string | null
}

const newestRecord = (): ISyncRecord | undefined =>
  get<ISyncRecord>(
    'SELECT started_at AS startedAt, ended_at AS endedAt, outcome, error FROM sync_run ORDER BY id DESC LIMIT 1'
  )

const RUN_IN_TERMINAL = 'Run logbook sync in a terminal to see the full output.'

const panel = (kind: FirstRunKind, headline: string, rest: Partial<IFirstRun> = {}): IFirstRun => ({
  kind,
  status: 200,
  headline,
  harnesses: [],
  notes: [],
  canSync: true,
  isReloading: false,
  ...rest,
})

// A part the row lacks (where it looked, the variable that points it elsewhere) is left out; a harness whose
// discovery recorded a problem shows the problem instead.
export const harnessLine = (harness: IHarness): IHarnessLine => {
  const at = harness.location === null ? '' : ` at ${harness.location}`
  const variable = harness.locationVariables[0]

  if (harness.problem !== null) {
    return { name: harness.name, text: harness.problem }
  }

  if (harness.isFound) {
    return { name: harness.name, text: `found${at}` }
  }

  const elsewhere = variable === undefined ? '' : `; set ${variable} if ${harness.name} keeps its data elsewhere`
  return { name: harness.name, text: `not found${at}${elsewhere}` }
}

const unreadablePanel = (): IFirstRun | null => {
  const problem = unreadable()

  if (problem === null) {
    return null
  }

  if (problem.kind === 'missing') {
    return panel('no-warehouse', `There is no warehouse at ${problem.path} yet. Sync creates it.`, { status: 503 })
  }

  const [version, reads] = [String(problem.version), String(SCHEMA_VERSION)]
  return problem.version > SCHEMA_VERSION
    ? panel(
        'newer-schema',
        `This warehouse is at schema ${version}, which a newer Log Book wrote; this Log Book reads ${reads}. Stop it and start the newer one.`,
        { status: 503, canSync: false }
      )
    : panel('older-schema', `This warehouse is at schema ${version}; Sync upgrades it to ${reads}.`, { status: 503 })
}

const harnessLines = (): IHarnessLine[] => [...harnessesOf().values()].map(harnessLine)

// The newest sync record decides, once no sync is running: a maintenance lock (compact, forget) is not one.
const recordPanel = (record: ISyncRecord | undefined): IFirstRun => {
  if (record === undefined) {
    return panel('never-synced', 'No sync has run yet.')
  }

  switch (record.endedAt === null ? null : record.outcome) {
    case 'ok':
      return panel('nothing-found', 'No agent data found yet.', { harnesses: harnessLines() })
    case 'partial':
      return panel('sync-problems', 'No agent data found yet.', {
        harnesses: harnessLines(),
        notes: [...(record.error === null ? [] : [record.error]), RUN_IN_TERMINAL],
      })
    case 'failed':
    case 'stopped':
    case null:
      return panel(
        'sync-failed',
        record.outcome === 'failed' && record.error !== null
          ? `The last sync failed: ${record.error}`
          : 'The last sync did not finish.',
        { notes: [RUN_IN_TERMINAL] }
      )
  }
}

const hasSessions = (): boolean => get<{ one: number }>('SELECT 1 AS one FROM session LIMIT 1') !== undefined

// Whether the warehouse can be read and holds a session, so there is something to label.
export const hasSomethingToLabel = (): boolean => unreadable() === null && hasSessions()

// The first check that applies decides: a warehouse the app cannot read, then one with no session yet; null is a
// warehouse with sessions, which the page reads.
export const firstRun = (now = Date.now()): IFirstRun | null => {
  const unreadableState = unreadablePanel()

  if (unreadableState !== null) {
    return unreadableState
  }

  if (hasSessions()) {
    return null
  }

  const lock = readSyncLock(resolveWarehousePath())
  if (lock.isHeld && lock.operation === 'sync' && lock.startedAt !== null) {
    const seconds = Math.max(0, Math.floor((now - lock.startedAt) / 1000))
    return panel(
      'first-sync',
      `Log Book is reading your agents' history for the first time. A sync is running, started ${plural(seconds, 'second')} ago.`,
      { isReloading: true }
    )
  }

  return recordPanel(newestRecord())
}

export type SyncTone = 'slow' | 'hollow' | 'good' | 'problem'

// The top bar's Sync control: what runs now, else how the last sync ended.
export interface ISyncControl {
  label: string
  // Shown on hover.
  title: string
  tone: SyncTone
  // A sync started while the lock is held would exit already running, so the button is disabled.
  isRunning: boolean
}

const SYNC_TITLE = 'Import what changed since the last sync'

// Specification 07's words. Forget's title does not suggest Ctrl+C: stopped after its deletion, it leaves the
// forgotten text in the file's free space until a compaction runs.
const RUNNING: Record<SyncLockOperation, { label: string; title: string }> = {
  compact: {
    label: 'Compacting',
    title:
      'logbook compact is rewriting the warehouse. Pages keep working; syncs and labelling wait until it ends. Stop it where it was started with Ctrl+C.',
  },
  forget: {
    label: 'Forgetting sessions',
    title:
      'logbook forget is removing sessions and rewriting the warehouse. Pages keep working; syncs and labelling wait until it ends.',
  },
  sync: { label: 'Syncing…', title: SYNC_TITLE },
}

const lastSync = (record: ISyncRecord | undefined, now: number): ISyncControl => {
  if (record === undefined) {
    return { label: 'Never synced', title: SYNC_TITLE, tone: 'hollow', isRunning: false }
  }

  const when = ago(record.endedAt ?? record.startedAt, now)
  const title = record.error ?? SYNC_TITLE

  switch (record.endedAt === null ? null : record.outcome) {
    case 'ok':
      return { label: `Synced ${when}`, title: SYNC_TITLE, tone: 'good', isRunning: false }
    case 'partial':
      return { label: `Synced ${when}, with problems`, title, tone: 'problem', isRunning: false }
    case 'failed':
    case 'stopped':
    case null:
      return { label: `Sync failed ${when}`, title, tone: 'problem', isRunning: false }
  }
}

// A held lock says what runs now, the newest record only how the last sync ended, so the lock decides first. A
// warehouse the app cannot read has no record to read.
export const syncControl = (now = Date.now()): ISyncControl => {
  const lock = readSyncLock(resolveWarehousePath())

  if (lock.isHeld && lock.operation !== null && lock.startedAt !== null) {
    const { label, title } = RUNNING[lock.operation]
    return { label: `${label} (since ${elapsed(now - lock.startedAt)})`, title, tone: 'slow', isRunning: true }
  }

  return lastSync(unreadable() === null ? newestRecord() : undefined, now)
}
