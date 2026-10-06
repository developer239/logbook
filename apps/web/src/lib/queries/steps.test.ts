import type { IBuiltDemo } from '@log-book/demo'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import {
  allTime,
  callRowsOf,
  callsOf,
  failedCallsOf,
  familyOf,
  idOf,
  isFailed,
  isRealResult,
} from '../../../test/plan-facts'
import { causeOf } from '../labels'
import { copyDemo, insert, type ITestWarehouse } from '../testing/warehouse'
import { USUAL_MIN_CALLS } from './calls'
import type * as Steps from './steps'

let demo: IBuiltDemo
let warehouse: ITestWarehouse
let steps: typeof Steps

// A call with no time of its own, which no harness of the set writes: it takes its message's time.
const UNTIMED = 'untimed-call'

beforeAll(async () => {
  demo = inject('demoSmall')
  warehouse = await copyDemo('demoSmall')
  const first = callsOf(demo)[0]
  if (first === undefined) {
    throw new Error('The small set plans no call')
  }
  const { message_id: messageId } = warehouse.db
    .prepare('SELECT message_id FROM tool_call WHERE id = ?')
    .get(idOf(demo, first.step.key)) as { message_id: string }
  insert(warehouse.db, 'tool_call', {
    id: UNTIMED,
    session_id: idOf(demo, first.sessionKey),
    message_id: messageId,
    name: 'Read',
    bare_name: 'Read',
    server: null,
    family: 'read',
    input_json: '{}',
    status: 'completed',
    started_at: null,
    ended_at: null,
  })
  steps = await import('./steps')
})

afterAll(async () => {
  await warehouse.remove()
})

const ask = (query: string, page = 0): ReturnType<typeof Steps.steps> =>
  steps.steps(steps.parseStepsQuery(new URLSearchParams(query)), allTime(demo), page)

// Every row of every page.
const allRows = (query: string): Steps.IStepRow[] => {
  const { total, pageSize } = ask(query)
  return Array.from({ length: Math.ceil(total / pageSize) }, (_, page) => ask(query, page).rows).flat()
}

const idsOf = (query: string): string[] =>
  ask(query)
    .rows.map((row) => row.id)
    .toSorted()

const byId = (left: { id: string }, right: { id: string }): number => left.id.localeCompare(right.id)

describe('steps', () => {
  it('should list every call of the range, the newest first, with where it happened', () => {
    const { rows, total, pageSize } = ask('')
    const planned = callRowsOf(demo)
    const newestAt = Math.max(...planned.map((placed) => placed.step.startAt))
    const newest = planned.filter((placed) => placed.step.startAt === newestAt)

    expect({
      total,
      pageSize,
      first: { at: rows[0]?.at, isNewest: newest.some((placed) => idOf(demo, placed.step.key) === rows[0]?.id) },
      sessionId: newest.map((placed) => idOf(demo, placed.sessionKey)).includes(rows[0]?.sessionId ?? ''),
    }).toStrictEqual({
      total: planned.length + 1,
      pageSize: 100,
      first: { at: newestAt, isNewest: true },
      sessionId: true,
    })
  })

  it('should give a call without a time of its own its message time and no duration', () => {
    const untimed = allRows('').find((row) => row.id === UNTIMED)
    const { created_at: messageAt } = warehouse.db
      .prepare('SELECT m.created_at FROM tool_call tc JOIN message m ON m.id = tc.message_id WHERE tc.id = ?')
      .get(UNTIMED) as { created_at: number }

    expect(untimed).toMatchObject({ at: messageAt, durationMs: null, usualMs: null })
  })

  it('should list the failed calls that were a problem, with their cause as shown', () => {
    const { rows } = ask('failed=1')
    const problems = failedCallsOf(demo).filter((call) => !isRealResult(call))

    expect(rows.map((row) => ({ id: row.id, cause: row.cause })).toSorted(byId)).toEqual(
      problems.map((call) => ({ id: call.id, cause: causeOf(call.family, call.label) })).toSorted(byId)
    )
  })

  it('should list the failures that were real results apart', () => {
    const real = failedCallsOf(demo).filter(isRealResult)

    expect({ ids: idsOf('real=1'), isAny: real.length > 0 }).toStrictEqual({
      ids: real.map((call) => call.id).toSorted(),
      isAny: true,
    })
  })

  it('should list the failed calls of one cause as shown', () => {
    const causes = failedCallsOf(demo)
      .filter((call) => !isRealResult(call))
      .map((call) => ({ id: call.id, cause: causeOf(call.family, call.label) }))
    const [cause = null, ofCause = []] =
      Map.groupBy(causes, (call) => call.cause)
        .entries()
        .toArray()
        .toSorted((left, right) => right[1].length - left[1].length)[0] ?? []
    if (cause === null) {
      throw new Error('The small set has no failed call with a cause')
    }

    expect(idsOf(`cause=${encodeURIComponent(cause)}`)).toEqual(ofCause.map((call) => call.id).toSorted())
  })

  it('should list the calls in a retry loop', () => {
    // A loop is one session calling one tool with one input three times or more, failing at least twice.
    const loops = Map.groupBy(
      callsOf(demo),
      (placed) =>
        `${placed.sessionKey} ${familyOf(placed.step)} ${placed.step.tool ?? ''} ${JSON.stringify(placed.step.input)}`
    )
      .values()
      .toArray()
      .filter((calls) => calls.length >= 3 && calls.filter((placed) => isFailed(placed.step)).length >= 2)

    expect({ ids: idsOf('loop=1'), loops: loops.length > 0 }).toStrictEqual({
      ids: loops
        .flat()
        .map((placed) => idOf(demo, placed.step.key))
        .toSorted(),
      loops: true,
    })
  })

  it('should list the calls of one tool in any case or MCP prefix', () => {
    const mcp = callsOf(demo).filter((placed) => placed.step.family === 'mcp' && placed.step.tool !== null)
    const tool = mcp[0]?.step.tool
    if (tool === undefined || tool === null) {
      throw new Error('The small set plans no MCP call with a tool name')
    }

    expect(idsOf(`tool=${tool.toUpperCase()}`)).toEqual(
      mcp
        .filter((placed) => placed.step.tool === tool)
        .map((placed) => idOf(demo, placed.step.key))
        .toSorted()
    )
  })

  it('should list no slow call of a tool too seldom called to have a usual time', () => {
    const counts = Map.groupBy(callsOf(demo), (placed) => placed.step.family)
    const seldom = counts.entries().find(([family, calls]) => family === 'web' && calls.length < USUAL_MIN_CALLS)
    const name = allRows('')
      .filter((row) => row.family === 'web')
      .map((row) => row.name)[0]

    expect({ isSeldom: seldom !== undefined, slow: ask(`slow=${name ?? ''}`) }).toMatchObject({
      isSeldom: true,
      slow: { rows: [], total: 0 },
    })
  })

  it('should list neither a dispatch nor a wait call as slow, with or without a server', () => {
    const waiting = allRows('').filter((row) => row.family === 'dispatch' || row.family === 'wait')

    expect({
      families: [...new Set(waiting.map((row) => row.family))].toSorted(),
      slow: waiting.map((row) => ask(`slow=${encodeURIComponent(row.name)}`).total),
    }).toStrictEqual({ families: ['dispatch', 'wait'], slow: waiting.map(() => 0) })
  })

  it('should list nothing for a page past the end', () => {
    const { total, pageSize } = ask('')

    expect(ask('', Math.ceil(total / pageSize))).toMatchObject({ rows: [], total })
  })

  it('should refuse a flag that is not 1', () => {
    expect(() => steps.parseStepsQuery(new URLSearchParams('failed=yes'))).toThrow('failed takes 1, got yes')
  })
})
