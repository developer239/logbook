import { countStartedBy, NOT_A_PROBLEM, type StartedBy } from '../labels'
import type { IRange } from '../range'
import { CALL_AT, modelLabel, startedBy } from '../sql'
import { get, all } from '../warehouse'
import { failedCalls } from './calls'

export interface IStrip {
  conversations: number
  by: Record<StartedBy, number>
  activeMs: number
  done: number
  calls: number
  failed: number
  realResults: number
}

const strip = (from: number, to: number): IStrip => {
  const sessions = all<{ startedBy: StartedBy; outcome: string | null }>(
    `SELECT ${startedBy('s')} AS startedBy, ${modelLabel('session', 's.id', 'outcome')} AS outcome
     FROM session s WHERE s.started_at >= ? AND s.started_at < ?`,
    from,
    to
  )

  const active =
    get<{ ms: number | null }>(
      'SELECT SUM(model_ms + tool_ms) AS ms FROM turn WHERE started_at >= ? AND started_at < ?',
      from,
      to
    )?.ms ?? 0

  const calls =
    get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM tool_call tc WHERE ${CALL_AT} >= ? AND ${CALL_AT} < ?`,
      from,
      to
    )?.total ?? 0

  const failed = failedCalls(from, to)
  const realResults = failed.filter(
    (call) => call.family === 'shell' && call.label !== null && NOT_A_PROBLEM.has(call.label)
  ).length

  return {
    conversations: sessions.length,
    by: countStartedBy(sessions),
    activeMs: active,
    done: sessions.filter((session) => session.outcome === 'done').length,
    calls,
    failed: failed.length,
    realResults,
  }
}

export const stripFor = (range: IRange): { current: IStrip; previous: IStrip | null } => ({
  current: strip(range.from, range.to),
  previous: range.previous === null ? null : strip(range.previous.from, range.previous.to),
})
