import { ERROR_CODES, LogBookError } from '@log-book/core'
import { WAREHOUSE_ERROR_CODES, WarehouseStore } from '@log-book/warehouse'
import type { RewriteStep } from './rewrite-messages.js'
import { bytesOf, failureOf, rewrittenSize, runRewriteProcess, underBothLocks, type IRewriteEnd } from './rewrite.js'

// Session ids (a warehouse id or the id the harness shows), or a project directory, which means its sessions now.
export type ForgetTarget = { readonly sessions: readonly string[] } | { readonly project: string }

export type ForgetProgress =
  // Before the deletion: the sessions the input named, and the subagent sessions added to them.
  | { readonly phase: 'resolved'; readonly named: number; readonly subagents: number }
  | { readonly phase: 'step-ended'; readonly step: RewriteStep }

// How far a forget got: nothing forgotten; forgotten, with the compaction stopped or failed; forgotten and rewritten.
export type ForgetState = 'nothing-forgotten' | 'forgotten' | 'rewritten'

export interface IForgetSessionsResult {
  outcome: 'ok' | 'stopped' | 'failed'
  state: ForgetState
  // The sessions removed, subagents included.
  sessionCount: number
  // The label rows removed; null when the deletion committed but was stopped before it reported them.
  labelCount: number | null
  // SQLite's message, for `failed`.
  error: string | null
  sizeBefore: number
  sizeAfter: number
  durationMs: number
}

export interface IForgetRun {
  warehousePath: string
  target: ForgetTarget
  signal: AbortSignal
  onProgress: (progress: ForgetProgress) => void
}

type TSettled = Omit<IForgetSessionsResult, 'sizeBefore' | 'durationMs'>

const unknown = (message: string): LogBookError =>
  new LogBookError(message, WAREHOUSE_ERROR_CODES.WAREHOUSE_SESSION_UNKNOWN)

// One session the id names, by its warehouse id or the id its harness shows; null when it names none.
const sessionNamed = (store: WarehouseStore, id: string): string | null => {
  const rows = store.all<{ id: string }>('SELECT id FROM session WHERE id = ? OR source_id = ?', id, id)
  if (rows.length > 1) {
    throw new LogBookError(
      `Session id ${id} matches ${String(rows.length)} sessions; pass the warehouse id.`,
      ERROR_CODES.VALIDATION_ERROR
    )
  }
  return rows[0]?.id ?? null
}

// The sessions the input names, refused naming what matches none before anything is deleted.
const resolve = (store: WarehouseStore, target: ForgetTarget): string[] => {
  if ('project' in target) {
    const ids = store.sessionsInProject(target.project)
    if (ids.length === 0) {
      throw unknown(`The warehouse holds no session in the project ${target.project}.`)
    }
    return ids
  }
  const named = target.sessions.map((id) => ({ id, session: sessionNamed(store, id) }))
  const missing = named.filter(({ session }) => session === null).map(({ id }) => id)
  if (missing.length > 0) {
    throw unknown(`The warehouse holds no session ${missing.join(', ')}.`)
  }
  return [...new Set(named.map(({ session }) => session ?? ''))]
}

// How far a forget that did not finish got, from the warehouse: the deletion took effect when the ids are in
// `forgotten`, the rewrite as for a compaction.
const reached = async (
  warehousePath: string,
  end: IRewriteEnd,
  sessionIds: readonly string[]
): Promise<Pick<IForgetSessionsResult, 'state' | 'sessionCount' | 'labelCount' | 'sizeAfter'>> => {
  const reader = await WarehouseStore.openReadOnly(warehousePath)
  try {
    const forgotten = reader.get<{ count: number }>(
      'SELECT count(*) AS count FROM forgotten WHERE session_id IN (SELECT value FROM json_each(?))',
      JSON.stringify(sessionIds)
    )
    if ((forgotten?.count ?? 0) < sessionIds.length) {
      return { state: 'nothing-forgotten', sessionCount: 0, labelCount: 0, sizeAfter: bytesOf(warehousePath) }
    }
    const rewritten = rewrittenSize(reader, end.pagesBeforeVacuum)
    return {
      state: rewritten === null ? 'forgotten' : 'rewritten',
      sessionCount: sessionIds.length,
      labelCount: end.forgotten?.labelCount ?? null,
      sizeAfter: rewritten ?? bytesOf(warehousePath),
    }
  } finally {
    reader.close()
  }
}

const settle = async (warehousePath: string, end: IRewriteEnd, sessionIds: readonly string[]): Promise<TSettled> => {
  if (end.isDone) {
    return {
      outcome: 'ok',
      state: 'rewritten',
      sessionCount: end.forgotten?.sessionCount ?? 0,
      labelCount: end.forgotten?.labelCount ?? 0,
      error: null,
      sizeAfter: bytesOf(warehousePath),
    }
  }
  return {
    outcome: end.isStopped ? 'stopped' : 'failed',
    error: end.isStopped ? null : failureOf(end),
    ...(await reached(warehousePath, end, sessionIds)),
  }
}

// The sessions and every subagent descendant, resolved in this process before the deletion starts.
const sessionsToForget = async (
  warehousePath: string,
  target: ForgetTarget,
  onProgress: IForgetRun['onProgress']
): Promise<string[]> => {
  const store = await WarehouseStore.open(warehousePath)
  try {
    const named = resolve(store, target)
    const ids = store.withSubagentDescendants(named)
    onProgress({ phase: 'resolved', named: named.length, subagents: ids.length - named.length })
    return ids
  } finally {
    store.close()
  }
}

// Removes everything Log Book holds about the sessions and their subagents, keeps their ids so a later sync does not
// import them again, and purges their text from the file with the compaction. Both locks are held for the whole run,
// and the deletion runs in the rewrite process, so a stop ends it at once instead of after its transaction.
export const runForget = async ({
  warehousePath,
  target,
  signal,
  onProgress,
}: IForgetRun): Promise<IForgetSessionsResult> => {
  const startedAt = Date.now()
  ;(await WarehouseStore.openReadOnly(warehousePath)).close()
  return underBothLocks(warehousePath, 'forget', async () => {
    const sessionIds = await sessionsToForget(warehousePath, target, onProgress)
    const sizeBefore = bytesOf(warehousePath)
    const task = { kind: 'forget', sessionIds, forgottenAt: Date.now() } as const
    const end = await runRewriteProcess(warehousePath, task, signal, (step) => {
      onProgress({ phase: 'step-ended', step })
    })
    return { ...(await settle(warehousePath, end, sessionIds)), sizeBefore, durationMs: Date.now() - startedAt }
  })
}
