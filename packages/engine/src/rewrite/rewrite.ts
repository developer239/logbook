import { fork } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { takeLabelsLock, takeSyncLock, type IHeldLock, type IWarehouseReader } from '@log-book/warehouse'
import type { RewriteMessage, RewriteStep, RewriteTask } from './rewrite-messages.js'

const thisModule = fileURLToPath(import.meta.url)

// The rewrite process's entry, beside this module with its extension: `.js` in the build, which the CLI's bundle
// ships beside its own entry, and `.ts` when the tests run the sources.
export const REWRITE_PROCESS_PATH = join(dirname(thisModule), `rewrite-process${extname(thisModule)}`)

export interface IRewriteEnd {
  isDone: boolean
  isStopped: boolean
  error: string | null
  // The deletion's report; null until it committed and reported, or for a compaction.
  forgotten: { sessionCount: number; labelCount: number } | null
  pagesBeforeVacuum: number | null
  // How the process ended: its signal, or its exit code.
  exit: string
}

// The warehouse file and its write-ahead log.
export const bytesOf = (warehousePath: string): number => {
  const wal = `${warehousePath}-wal`
  return statSync(warehousePath).size + (existsSync(wal) ? statSync(wal).size : 0)
}

// The sync lock, then the labelling lock, for the whole of `work`, so a sync, a labelling run or a drop started
// meanwhile exits "already running" instead of failing on SQLite's busy timeout. A held one ends it with its holder
// before `work` starts; both are released once `work` has ended.
export const underBothLocks = async <TResult>(
  warehousePath: string,
  operation: 'compact' | 'forget',
  work: () => Promise<TResult>
): Promise<TResult> => {
  const syncLock = takeSyncLock(warehousePath, operation)
  let labelsLock: IHeldLock | null = null
  try {
    labelsLock = takeLabelsLock(warehousePath, operation)
    return await work()
  } finally {
    labelsLock?.release()
    syncLock.release()
  }
}

const record = (end: IRewriteEnd, message: RewriteMessage, onStep: (step: RewriteStep) => void): void => {
  if (message.type === 'step-ended') {
    onStep(message.step)
  } else if (message.type === 'forgotten') {
    end.forgotten = { sessionCount: message.sessionCount, labelCount: message.labelCount }
  } else if (message.type === 'pages-before-vacuum') {
    end.pagesBeforeVacuum = message.pages
  } else if (message.type === 'failed') {
    end.error = message.message
  } else {
    end.isDone = true
  }
}

// Runs the rewrite process to its end. The signal kills it at once: `VACUUM` runs synchronously and cannot be
// interrupted, while SQLite rolls back a transaction whose process ended before it committed.
export const runRewriteProcess = async (
  warehousePath: string,
  task: RewriteTask,
  signal: AbortSignal,
  onStep: (step: RewriteStep) => void
): Promise<IRewriteEnd> =>
  new Promise((resolve, reject) => {
    const child = fork(REWRITE_PROCESS_PATH, [warehousePath], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      execArgv: [],
    })
    const end: IRewriteEnd = {
      isDone: false,
      isStopped: false,
      error: null,
      forgotten: null,
      pagesBeforeVacuum: null,
      exit: '',
    }
    const stop = (): void => {
      end.isStopped = true
      child.kill('SIGKILL')
    }
    child.on('message', (message: RewriteMessage) => {
      record(end, message, onStep)
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
      child.send(task)
    }
  })

// Whether the rewrite took effect, from the warehouse and never from the last report: the process can be killed
// between a commit and its report. It took effect when the file has fewer pages than before `VACUUM`; a rewrite
// stopped in its checkpoint still has part of itself in the log, so its size is its pages times their size.
export const rewrittenSize = (reader: IWarehouseReader, pagesBeforeVacuum: number | null): number | null => {
  const pages = reader.get<{ page_count: number }>('PRAGMA page_count')?.page_count ?? 0
  const pageSize = reader.get<{ page_size: number }>('PRAGMA page_size')?.page_size ?? 0
  return pagesBeforeVacuum !== null && pages < pagesBeforeVacuum ? pages * pageSize : null
}

// The message of a rewrite that ended without finishing and was not stopped.
export const failureOf = (end: IRewriteEnd): string =>
  end.error ?? `The rewrite process ended with ${end.exit} before it finished.`
