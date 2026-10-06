import { NotFoundError, ParamError } from './errors'
import { firstRun, type IFirstRun } from './state'

// A page's own problem line, or the first-run panel every page shows while the warehouse has nothing to show.
export type PageProblem = string | IFirstRun

export type Loaded<TData> = { ok: true; data: TData } | { ok: false; problem: PageProblem; status: number }

export const load = <TData>(read: () => TData): Loaded<TData> => {
  const state = firstRun()

  if (state !== null) {
    return { ok: false, problem: state, status: state.status }
  }

  try {
    return { ok: true, data: read() }
  } catch (error) {
    if (error instanceof ParamError || error instanceof NotFoundError) {
      return { ok: false, problem: error.message, status: error.status }
    }

    throw error
  }
}
