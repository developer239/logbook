import { fork } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { takeLabelsLock, takeSyncLock, WarehouseStore, type IHeldLock } from '@log-book/warehouse'
import type { RewriteMessage, RewriteStep } from './rewrite-messages.js'

const thisModule = fileURLToPath(import.meta.url)

// The rewrite process's entry, beside this module with its extension: `.js` in the build, which the CLI's bundle
// ships beside its own entry, and `.ts` when the tests run the sources.
export const REWRITE_PROCESS_PATH = join(dirname(thisModule), `rewrite-process${extname(thisModule)}`)

export type CompactProgress =
  // Once both locks are held, before the rewrite starts: the warehouse file and its write-ahead log.
  | { readonly phase: 'started'; readonly sizeBefore: number }
  | { readonly phase: 'step-ended'; readonly step: RewriteStep }

export interface ICompactResult {
  outcome: 'ok' | 'stopped' | 'failed'
  // The rewrite took effect: after `ok`, and after a stop that came once it had committed.
  isRewritten: boolean
  // SQLite's message, for `failed`.
  error: string | null
  sizeBefore: number
  sizeAfter: number
  durationMs: number
}

export interface ICompactRun {
  warehousePath: string
  signal: AbortSignal
  onProgress: (progress: CompactProgress) => void
}

interface IRewriteEnd {
  isDone: boolean
  isStopped: boolean
  error: string | null
  pagesBeforeVacuum: number | null
  exit: string
}

type TSettled = Pick<ICompactResult, 'outcome' | 'isRewritten' | 'error' | 'sizeAfter'>

const bytesOf = (warehousePath: string): number => {
  const wal = `${warehousePath}-wal`
  return statSync(warehousePath).size + (existsSync(wal) ? statSync(wal).size : 0)
}

// The sync lock, then the labelling lock: a held one ends the compaction with its holder before a byte changes.
const takeBothLocks = (warehousePath: string): IHeldLock[] => {
  const syncLock = takeSyncLock(warehousePath, 'compact')
  try {
    return [syncLock, takeLabelsLock(warehousePath, 'compact')]
  } catch (error: unknown) {
    syncLock.release()
    throw error
  }
}

const record = (end: IRewriteEnd, message: RewriteMessage, onProgress: ICompactRun['onProgress']): void => {
  if (message.type === 'step-ended') {
    onProgress({ phase: 'step-ended', step: message.step })
  } else if (message.type === 'pages-before-vacuum') {
    end.pagesBeforeVacuum = message.pages
  } else if (message.type === 'failed') {
    end.error = message.message
  } else {
    end.isDone = true
  }
}

// Runs the rewrite process to its end. The signal kills it at once: `VACUUM` runs synchronously and cannot be
// interrupted, while SQLite rolls back a rewrite whose process ended before it committed.
const rewrite = async (
  warehousePath: string,
  signal: AbortSignal,
  onProgress: ICompactRun['onProgress']
): Promise<IRewriteEnd> =>
  new Promise((resolve, reject) => {
    const child = fork(REWRITE_PROCESS_PATH, [warehousePath], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      execArgv: [],
    })
    const end: IRewriteEnd = { isDone: false, isStopped: false, error: null, pagesBeforeVacuum: null, exit: '' }
    const stop = (): void => {
      end.isStopped = true
      child.kill('SIGKILL')
    }
    child.on('message', (message: RewriteMessage) => {
      record(end, message, onProgress)
    })
    child.on('error', reject)
    child.on('close', (code, exitSignal) => {
      signal.removeEventListener('abort', stop)
      end.exit = exitSignal ?? `code ${String(code)}`
      resolve(end)
    })
    if (signal.aborted) {
      stop()
    } else {
      signal.addEventListener('abort', stop, { once: true })
    }
  })

// Where a stopped rewrite stopped, from the warehouse and never from the last report: the process can be killed
// between a commit and its report. The rewrite took effect when the file has fewer pages than before `VACUUM`.
const settleStopped = async (warehousePath: string, pagesBeforeVacuum: number | null): Promise<TSettled> => {
  const reader = await WarehouseStore.openReadOnly(warehousePath)
  try {
    const pages = reader.get<{ page_count: number }>('PRAGMA page_count')?.page_count ?? 0
    const pageSize = reader.get<{ page_size: number }>('PRAGMA page_size')?.page_size ?? 0
    const isRewritten = pagesBeforeVacuum !== null && pages < pagesBeforeVacuum
    // A rewrite stopped in its checkpoint still has part of itself in the log, so the file's size says nothing yet.
    return {
      outcome: 'stopped',
      isRewritten,
      error: null,
      sizeAfter: isRewritten ? pages * pageSize : bytesOf(warehousePath),
    }
  } finally {
    reader.close()
  }
}

const settle = async (warehousePath: string, end: IRewriteEnd): Promise<TSettled> => {
  if (end.isDone) {
    return { outcome: 'ok', isRewritten: true, error: null, sizeAfter: bytesOf(warehousePath) }
  }
  if (end.isStopped) {
    return settleStopped(warehousePath, end.pagesBeforeVacuum)
  }
  const error = end.error ?? `The rewrite process ended with ${end.exit} before it finished.`
  return { outcome: 'failed', isRewritten: false, error, sizeAfter: bytesOf(warehousePath) }
}

// Gives back the disk space syncs leave free inside the warehouse. Both locks are held in this process for the whole
// run, so a sync, a labelling run or a drop started meanwhile exits "already running" instead of failing on SQLite's
// busy timeout, and they are released only after the rewrite process has ended.
export const runCompact = async ({ warehousePath, signal, onProgress }: ICompactRun): Promise<ICompactResult> => {
  const startedAt = Date.now()
  // A missing warehouse, or one at another version, ends it with the store's error before a lock file is written.
  ;(await WarehouseStore.openReadOnly(warehousePath)).close()
  const locks = takeBothLocks(warehousePath)
  try {
    const sizeBefore = bytesOf(warehousePath)
    onProgress({ phase: 'started', sizeBefore })
    const settled = await settle(warehousePath, await rewrite(warehousePath, signal, onProgress))
    return { ...settled, sizeBefore, durationMs: Date.now() - startedAt }
  } finally {
    for (const lock of locks.toReversed()) {
      lock.release()
    }
  }
}
