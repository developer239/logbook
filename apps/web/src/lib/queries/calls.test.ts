import type { IBuiltDemo } from '@log-book/demo'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import {
  allTime,
  callRowsOf,
  callsOf,
  failedCallsOf,
  familyOf,
  idOf,
  purposeLabelOf,
  type IPlacedStep,
  type TCallStep,
} from '../../../test/plan-facts'
import { typical } from '../format'
import { causeOf } from '../labels'
import { copyDemo, insert, type ITestWarehouse } from '../testing/warehouse'
import { MINUTE, SECOND } from '../time'
import type * as Calls from './calls'

let demo: IBuiltDemo
let warehouse: ITestWarehouse
let calls: typeof Calls

interface ITimed {
  id: string
  name: string
  family: string
  purpose: string | null
  durationMs: number
  at: number
}

// Odd rows on top of the copy: enough quick calls of a planned read tool to give it a usual time, then one that took
// five minutes.
const SLOW_CALL = 'slow-read'
let odd: ITimed[] = []

const readCall = (): IPlacedStep<TCallStep> => {
  const read = callsOf(demo).find((placed) => placed.step.family === 'read')
  if (read === undefined) {
    throw new Error('The small set plans no read call')
  }
  return read
}

beforeAll(async () => {
  demo = inject('demoSmall')
  warehouse = await copyDemo('demoSmall')
  calls = await import('./calls')
  const read = readCall()
  const row = warehouse.db
    .prepare('SELECT session_id, message_id, name, bare_name, family FROM tool_call WHERE id = ?')
    .get(idOf(demo, read.step.key)) as {
    session_id: string
    message_id: string
    name: string
    bare_name: string
    family: string
  }
  const timed = (id: string, at: number, durationMs: number): ITimed => ({
    id,
    name: row.bare_name,
    family: row.family,
    purpose: null,
    durationMs,
    at,
  })
  odd = [
    ...Array.from({ length: calls.USUAL_MIN_CALLS }, (_, index) =>
      timed(`quick-read-${String(index)}`, read.step.startAt + index * SECOND, SECOND)
    ),
    timed(SLOW_CALL, read.step.startAt + MINUTE, 5 * MINUTE),
  ]
  for (const call of odd) {
    insert(warehouse.db, 'tool_call', {
      id: call.id,
      session_id: row.session_id,
      message_id: row.message_id,
      name: row.name,
      bare_name: row.bare_name,
      family: row.family,
      input_json: '{}',
      status: 'completed',
      started_at: call.at,
      ended_at: call.at + call.durationMs,
    })
  }
})

afterAll(async () => {
  await warehouse.remove()
})

const recordedName = (id: string): string =>
  (warehouse.db.prepare('SELECT bare_name FROM tool_call WHERE id = ?').get(id) as { bare_name: string }).bare_name

// Every timed call that does not wait on something by design, the planned ones and the odd ones.
const timedCalls = (): ITimed[] =>
  [
    ...callRowsOf(demo).flatMap((placed): ITimed[] => {
      const { step } = placed
      if (step.kind !== 'call') {
        return [
          {
            id: idOf(demo, step.key),
            name: recordedName(idOf(demo, step.key)),
            family: step.kind === 'spawn' ? 'subagent' : 'skill',
            purpose: null,
            durationMs: step.endAt - step.startAt,
            at: step.startAt,
          },
        ]
      }
      return step.endAt === null
        ? []
        : [
            {
              id: idOf(demo, step.key),
              name: recordedName(idOf(demo, step.key)),
              family: familyOf(step),
              purpose: purposeLabelOf(demo, step),
              durationMs: step.endAt - step.startAt,
              at: step.startAt,
            },
          ]
    }),
    ...odd,
  ].filter(
    (call) =>
      !['subagent', 'dispatch', 'question', 'wait'].includes(call.family) && call.purpose !== 'wait for something'
  )

const usualTimes = (): Map<string, number> =>
  new Map(
    [...Map.groupBy(timedCalls(), calls.slowKey)]
      .filter(([, ofKey]) => ofKey.length >= calls.USUAL_MIN_CALLS)
      .map(([key, ofKey]) => [key, typical(ofKey.map((call) => call.durationMs))])
  )

const causeCounts = (): Map<string, number> =>
  new Map(
    [
      ...Map.groupBy(
        failedCallsOf(demo).flatMap((call) => {
          const cause = causeOf(call.family, call.label)
          return cause === null ? [] : [cause]
        }),
        (cause) => cause
      ),
    ].map(([cause, ofCause]) => [cause, ofCause.length])
  )

const byId = (left: (string | null)[], right: (string | null)[]): number =>
  String(left[0]).localeCompare(String(right[0]))

describe('failedCalls', () => {
  it('should list every failed call with the label its failure reads by', () => {
    const failed = calls.failedCalls(0, Number.MAX_SAFE_INTEGER)

    expect(failed.map((call) => [call.id, call.label]).toSorted(byId)).toEqual(
      failedCallsOf(demo)
        .map((call) => [call.id, call.label])
        .toSorted(byId)
    )
  })

  it('should leave out the calls of another range', () => {
    const [first] = failedCallsOf(demo)
    if (first === undefined) {
      throw new Error('The small set plans no failed call')
    }
    const at = first.step.startAt

    expect(
      calls
        .failedCalls(at, at + 1)
        .map((call) => call.id)
        .toSorted()
    ).toEqual(
      failedCallsOf(demo)
        .filter((call) => call.step.startAt === at)
        .map((call) => call.id)
        .toSorted()
    )
  })
})

describe('causeCounts', () => {
  it('should count failed calls by cause as shown, leaving out real results', () => {
    expect(calls.causeCounts(0, Number.MAX_SAFE_INTEGER)).toEqual(causeCounts())
  })
})

describe('failuresWithCause', () => {
  it('should count the failed calls of a cause as shown, whichever labels lead to it', () => {
    const expected = causeCounts()

    expect({
      counts: new Map([...expected.keys()].map((cause) => [cause, calls.failuresWithCause(cause)])),
      isAny: expected.size > 0,
    }).toEqual({ counts: expected, isAny: true })
  })

  it('should count none for a name that is no cause as shown', () => {
    expect(calls.failuresWithCause('Made up')).toBe(0)
  })
})

describe('slowCalls', () => {
  it('should group the calls well over their tool usual time by tool', () => {
    const usual = usualTimes()
    const slow = timedCalls().flatMap((call) => {
      const usualMs = usual.get(calls.slowKey(call))
      return usualMs === undefined || call.durationMs <= Math.max(calls.SLOW_FLOOR_MS, calls.SLOW_FACTOR * usualMs)
        ? []
        : [{ call, usualMs }]
    })
    const groups = [...Map.groupBy(slow, (entry) => calls.slowKey(entry.call))].map(([key, entries]) => {
      const usualMs = entries[0]?.usualMs ?? 0
      return {
        key,
        calls: entries.length,
        overMs: Math.max(calls.SLOW_FLOOR_MS, calls.SLOW_FACTOR * usualMs),
        usualMs,
        longestMs: Math.max(...entries.map((entry) => entry.call.durationMs)),
      }
    })

    const found = calls.slowCalls(allTime(demo))

    expect({ ...found, isSlowRead: slow.some((entry) => entry.call.id === SLOW_CALL) }).toEqual({
      groups: groups.toSorted(
        (left, right) => right.longestMs / Math.max(right.usualMs, 1) - left.longestMs / Math.max(left.usualMs, 1)
      ),
      total: slow.length,
      isSlowRead: true,
    })
  })

  it('should have a usual time only for a tool with enough timed calls', () => {
    const counts = Map.groupBy(timedCalls(), calls.slowKey)
    const seldom = timedCalls().find((call) => (counts.get(calls.slowKey(call))?.length ?? 0) < calls.USUAL_MIN_CALLS)
    const read = odd[0]
    if (seldom === undefined || read === undefined) {
      throw new Error('The small set has no tool too seldom called to have a usual time')
    }

    expect({ read: calls.usualTime(read), seldom: calls.usualTime(seldom) }).toStrictEqual({
      read: usualTimes().get(calls.slowKey(read)),
      seldom: null,
    })
  })

  it('should call a call slow only against a usual time, and over the floor', () => {
    const read = odd[0]
    const seldom = timedCalls().find(
      (call) => (Map.groupBy(timedCalls(), calls.slowKey).get(calls.slowKey(call))?.length ?? 0) < calls.USUAL_MIN_CALLS
    )
    if (read === undefined || seldom === undefined) {
      throw new Error('The small set has no tool too seldom called to have a usual time')
    }

    expect({
      slow: calls.isSlow(read, 5 * MINUTE),
      underFloor: calls.isSlow(read, calls.SLOW_FLOOR_MS - SECOND),
      seldom: calls.isSlow(seldom, 5 * MINUTE),
      untimed: calls.isSlow(read, null),
    }).toStrictEqual({ slow: true, underFloor: false, seldom: false, untimed: false })
  })
})
