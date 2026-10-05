import { ParamError } from '../errors'
import { causeOf } from '../labels'
import type { IRange } from '../range'
import { CALL_AT, callAt, failureLabel, purposeLabel, retryLoop, titleOf, toolIs, turnOfCall } from '../sql'
import { toolName } from '../tools'
import { all } from '../warehouse'
import { hasCause, isProblem, isRealResult, isSlow, slowKey, usualTime } from './calls'
import { allOf, type ISqlCondition, pagedRows } from './paged'

export interface IStepsQuery {
  // Failed calls that were a problem.
  failed: boolean
  cause: string | null
  // Failed shell calls whose failure was a real result.
  real: boolean
  // Unusually slow calls of one tool, or shell purpose (the dashboard's key).
  slow: string | null
  loop: boolean
  tool: string | null
}

const FLAGS = ['failed', 'real', 'loop'] as const
const TEXTS = ['cause', 'slow', 'tool'] as const

const flag = (params: URLSearchParams, name: string): boolean => {
  const value = params.get(name)

  if (value !== null && value !== '1') {
    throw new ParamError(`${name} takes 1, got ${value}`)
  }

  return value === '1'
}

export const parseStepsQuery = (params: URLSearchParams): IStepsQuery =>
  Object.fromEntries([
    ...FLAGS.map((name) => [name, flag(params, name)]),
    ...TEXTS.map((name) => [name, params.get(name)]),
  ]) as IStepsQuery

export interface IStepRow {
  id: string
  sessionId: string
  title: string | null
  turnId: string | null
  name: string
  family: string
  status: string
  inputJson: string
  at: number
  durationMs: number | null
  purpose: string | null
  cause: string | null
  usualMs: number | null
}

const PAGE_SIZE = 100

type CallRow = Omit<IStepRow, 'cause' | 'usualMs' | 'title' | 'turnId'> & { label: string | null }

const COLUMNS = `tc.id, tc.session_id AS sessionId, tc.name, tc.family, tc.status, tc.input_json AS inputJson,
  ${CALL_AT} AS at, tc.ended_at - tc.started_at AS durationMs,
  ${purposeLabel('tc')} AS purpose, ${failureLabel('tc')} AS label`

// Whether a call is slow is left out: it compares the call with its tool's usual time.
const conditionsOf = (query: IStepsQuery, range: IRange): ISqlCondition => {
  const label = failureLabel('tc')
  const isFailure = query.failed || query.cause !== null || query.real

  return allOf([
    { sql: `${CALL_AT} >= ? AND ${CALL_AT} < ?`, params: [range.from, range.to] },
    ...(isFailure ? [{ sql: `tc.status = 'error'`, params: [] }] : []),
    ...(query.failed ? [isProblem('tc.family', label)] : []),
    ...(query.cause === null ? [] : [hasCause('tc.family', label, [query.cause])]),
    ...(query.real ? [isRealResult('tc.family', label)] : []),
    ...(query.slow === null ? [] : [{ sql: 'tc.started_at IS NOT NULL AND tc.ended_at IS NOT NULL', params: [] }]),
    ...(query.tool === null ? [] : [{ sql: toolIs('tc.name'), params: [query.tool, query.tool] }]),
    ...(query.loop
      ? [
          {
            sql: `(tc.session_id, tc.name, tc.input_json) IN (SELECT l.session_id, l.name, l.input_json
              FROM tool_call l WHERE ${callAt('l')} >= ? AND ${callAt('l')} < ?
              GROUP BY l.session_id, l.name, l.input_json HAVING ${retryLoop('l')})`,
            params: [range.from, range.to],
          },
        ]
      : []),
  ])
}

export const steps = (
  query: IStepsQuery,
  range: IRange,
  page: number
): { rows: IStepRow[]; total: number; pageSize: number } => {
  const list = { columns: COLUMNS, from: 'tool_call tc', where: conditionsOf(query, range), order: 'at DESC, tc.id' }
  const { slow } = query

  // Slowness is judged in TypeScript, so only that list is read whole and cut to the page.
  const { rows: calls, total } =
    slow === null
      ? pagedRows<CallRow>(list, page, PAGE_SIZE)
      : slowPage(
          all<CallRow>(
            `SELECT ${list.columns} FROM ${list.from} WHERE ${list.where.sql} ORDER BY ${list.order}`,
            ...list.where.params
          ),
          slow,
          page
        )

  const shown = calls.map((call) => ({
    ...call,
    cause: call.status === 'error' ? causeOf(call.family, call.label) : null,
  }))

  const where = all<{ id: string; title: string | null; turnId: string | null }>(
    `SELECT tc.id, ${titleOf('tc.session_id')} AS title, ${turnOfCall('tc.id')} AS turnId
     FROM tool_call tc WHERE tc.id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(shown.map((call) => call.id))
  )
  const byId = new Map(where.map((row) => [row.id, row]))

  return {
    rows: shown.map(({ label: _label, ...call }) => ({
      ...call,
      name: toolName(call.name),
      title: byId.get(call.id)?.title ?? null,
      turnId: byId.get(call.id)?.turnId ?? null,
      usualMs: call.durationMs === null ? null : usualTime(call),
    })),
    total,
    pageSize: PAGE_SIZE,
  }
}

const slowPage = (calls: readonly CallRow[], key: string, page: number): { rows: CallRow[]; total: number } => {
  const slow = calls.filter((call) => slowKey(call) === key && isSlow(call, call.durationMs))
  return { rows: slow.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), total: slow.length }
}
