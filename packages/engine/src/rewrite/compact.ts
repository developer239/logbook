import { WarehouseStore } from '@log-book/warehouse'
import type { RewriteStep } from './rewrite-messages.js'
import { bytesOf, failureOf, rewrittenSize, runRewriteProcess, underBothLocks, type IRewriteEnd } from './rewrite.js'

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

type TSettled = Pick<ICompactResult, 'outcome' | 'isRewritten' | 'error' | 'sizeAfter'>

const settle = async (warehousePath: string, end: IRewriteEnd): Promise<TSettled> => {
  if (end.isDone) {
    return { outcome: 'ok', isRewritten: true, error: null, sizeAfter: bytesOf(warehousePath) }
  }
  if (!end.isStopped) {
    return { outcome: 'failed', isRewritten: false, error: failureOf(end), sizeAfter: bytesOf(warehousePath) }
  }
  const reader = await WarehouseStore.openReadOnly(warehousePath)
  try {
    const rewritten = rewrittenSize(reader, end.pagesBeforeVacuum)
    return {
      outcome: 'stopped',
      isRewritten: rewritten !== null,
      error: null,
      sizeAfter: rewritten ?? bytesOf(warehousePath),
    }
  } finally {
    reader.close()
  }
}

// Gives back the disk space syncs leave free inside the warehouse, under both locks for the whole run.
export const runCompact = async ({ warehousePath, signal, onProgress }: ICompactRun): Promise<ICompactResult> => {
  const startedAt = Date.now()
  // A missing warehouse, or one at another version, ends it with the store's error before a lock file is written.
  ;(await WarehouseStore.openReadOnly(warehousePath)).close()
  return underBothLocks(warehousePath, 'compact', async () => {
    const sizeBefore = bytesOf(warehousePath)
    onProgress({ phase: 'started', sizeBefore })
    const end = await runRewriteProcess(warehousePath, { kind: 'compact' }, signal, (step) => {
      onProgress({ phase: 'step-ended', step })
    })
    return { ...(await settle(warehousePath, end)), sizeBefore, durationMs: Date.now() - startedAt }
  })
}
