import { typical } from '../format'
import { causeOf, KNOWN_LABELS, labelsOfCause, NOT_A_PROBLEM, purposeName, UNLABELLED } from '../labels'
import { countBy, sumBy } from '../lists'
import type { IRange } from '../range'
import { CALL_AT, failureLabel, purposeLabel } from '../sql'
import { SECOND } from '../time'
import { normalName, toolName } from '../tools'
import { all, get, syncedAt } from '../warehouse'
import type { ISqlCondition } from './paged'

export interface IFailedCall {
  id: string
  name: string
  family: string
  at: number
  label: string | null
}

export const failedCalls = (from: number, to: number): IFailedCall[] =>
  all(
    `SELECT tc.id, tc.name, tc.family, ${CALL_AT} AS at, ${failureLabel('tc')} AS label
     FROM tool_call tc WHERE tc.status = 'error' AND ${CALL_AT} >= ? AND ${CALL_AT} < ?`,
    from,
    to
  )

export const causeCounts = (from: number, to: number): Map<string, number> =>
  countBy(
    failedCalls(from, to)
      .map((call) => causeOf(call.family, call.label))
      .filter((cause) => cause !== null),
    (cause) => cause
  )

const marks = (values: readonly string[]): string => values.map(() => '?').join(', ')

export const hasCause = (family: string, label: string, causes: readonly string[]): ISqlCondition => {
  const conditions = causes.map((cause): ISqlCondition => {
    if (cause === UNLABELLED) {
      return {
        sql: `(${label} IS NULL
          OR (${family} = 'shell' AND ${label} NOT IN (${marks(KNOWN_LABELS.shell)}))
          OR (${family} <> 'shell' AND ${label} NOT IN (${marks(KNOWN_LABELS.other)})))`,
        params: [...KNOWN_LABELS.shell, ...KNOWN_LABELS.other],
      }
    }

    const { shell, other } = labelsOfCause(cause)

    return {
      sql: `(${[
        ...(shell.length === 0 ? [] : [`(${family} = 'shell' AND ${label} IN (${marks(shell)}))`]),
        ...(other.length === 0 ? [] : [`(${family} <> 'shell' AND ${label} IN (${marks(other)}))`]),
        // A name that is no cause as shown matches no call.
        ...(shell.length + other.length === 0 ? ['0'] : []),
      ].join(' OR ')})`,
      params: [...shell, ...other],
    }
  })

  return {
    sql: `(${conditions.map((condition) => condition.sql).join(' OR ')})`,
    params: conditions.flatMap((condition) => condition.params),
  }
}

export const failuresWithCause = (cause: string): number => {
  const condition = hasCause('tc.family', failureLabel('tc'), [cause])
  const counted = get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM tool_call tc WHERE tc.status = 'error' AND ${condition.sql}`,
    ...condition.params
  )

  return counted?.total ?? 0
}

export const isRealResult = (family: string, label: string): ISqlCondition => ({
  sql: `(${family} = 'shell' AND ${label} IN (${marks([...NOT_A_PROBLEM])}))`,
  params: [...NOT_A_PROBLEM],
})

export const isProblem = (family: string, label: string): ISqlCondition => {
  const real = isRealResult(family, label)
  return { sql: `NOT COALESCE(${real.sql}, 0)`, params: real.params }
}

export interface ICallLike {
  name: string
  family: string
  purpose: string | null
}

interface ITimedCall extends ICallLike {
  id: string
  durationMs: number
  at: number
}

export const SLOW_FACTOR = 10
export const SLOW_FLOOR_MS = 30 * SECOND
export const USUAL_MIN_CALLS = 20

const WAITING_FAMILIES = new Set(['subagent', 'dispatch', 'question'])
const WAITING_TOOLS = new Set(['monitor', 'oc_wait_runs', 'orch_wait', 'taskoutput', 'sleep'])
const WAITING_PURPOSE = 'wait for something'

let baselineCache: { syncedAt: number | null; usual: Map<string, number> } | undefined

export const slowKey = (call: ICallLike): string =>
  call.family === 'shell' ? `${toolName(call.name)} · ${purposeName(call.purpose) ?? 'other'}` : toolName(call.name)

const isWaiting = (call: ICallLike): boolean =>
  WAITING_FAMILIES.has(call.family) || WAITING_TOOLS.has(normalName(call.name)) || call.purpose === WAITING_PURPOSE

const timedCalls = (from: number, to: number): ITimedCall[] =>
  all<ITimedCall>(
    `SELECT tc.id, tc.name, tc.family, tc.ended_at - tc.started_at AS durationMs, tc.started_at AS at,
       ${purposeLabel('tc')} AS purpose
     FROM tool_call tc WHERE tc.started_at IS NOT NULL AND tc.ended_at IS NOT NULL
       AND tc.started_at >= ? AND tc.started_at < ?`,
    from,
    to
  ).filter((call) => !isWaiting(call))

const usualTimes = (): Map<string, number> => {
  const synced = syncedAt()

  if (baselineCache?.syncedAt !== synced) {
    baselineCache = {
      syncedAt: synced,
      usual: new Map(
        [...Map.groupBy(timedCalls(0, Number.MAX_SAFE_INTEGER), slowKey)]
          .filter(([, calls]) => calls.length >= USUAL_MIN_CALLS)
          .map(([key, calls]) => [key, typical(calls.map((call) => call.durationMs))])
      ),
    }
  }

  return baselineCache.usual
}

export const usualTime = (call: ICallLike): number | null => usualTimes().get(slowKey(call)) ?? null

export const isSlow = (call: ICallLike, durationMs: number | null): boolean => {
  const usual = usualTime(call)

  if (durationMs === null || usual === null || isWaiting(call)) {
    return false
  }

  return durationMs > Math.max(SLOW_FLOOR_MS, SLOW_FACTOR * usual)
}

export interface ISlowGroup {
  key: string
  calls: number
  overMs: number
  usualMs: number
  longestMs: number
}

export const slowCalls = (range: IRange): { groups: ISlowGroup[]; total: number } => {
  const usual = usualTimes()
  const groups = new Map<string, ISlowGroup>()

  for (const call of timedCalls(range.from, range.to)) {
    const key = slowKey(call)
    const usualMs = usual.get(key)

    if (usualMs === undefined) {
      continue
    }

    const overMs = Math.max(SLOW_FLOOR_MS, SLOW_FACTOR * usualMs)

    if (call.durationMs <= overMs) {
      continue
    }

    const group = groups.get(key) ?? { key, calls: 0, overMs, usualMs, longestMs: 0 }
    group.calls += 1
    group.longestMs = Math.max(group.longestMs, call.durationMs)
    groups.set(key, group)
  }

  const sorted = [...groups.values()].toSorted(
    (left, right) => right.longestMs / Math.max(right.usualMs, 1) - left.longestMs / Math.max(left.usualMs, 1)
  )

  return { groups: sorted, total: sumBy(sorted, (group) => group.calls) }
}
