import { NotFoundError, ParamError } from './errors'
import { firstRun, type IFirstRun } from './state'
import { syncedAt, unreadable } from './warehouse'

// A page's own problem line, or the first-run panel every page shows while the warehouse has nothing to show.
export type PageProblem = string | IFirstRun

export type Loaded<TData> =
  | { ok: true; data: TData; syncedAt: number | null }
  | { ok: false; problem: PageProblem; status: number; syncedAt: number | null }

export const syncedAtOrNull = (): number | null => (unreadable() === null ? syncedAt() : null)

export const load = <TData>(read: () => TData): Loaded<TData> => {
  const state = firstRun()

  if (state !== null) {
    return { ok: false, problem: state, status: state.status, syncedAt: syncedAtOrNull() }
  }

  try {
    return { ok: true, data: read(), syncedAt: syncedAt() }
  } catch (error) {
    if (error instanceof ParamError || error instanceof NotFoundError) {
      return { ok: false, problem: error.message, status: error.status, syncedAt: syncedAt() }
    }

    throw error
  }
}
