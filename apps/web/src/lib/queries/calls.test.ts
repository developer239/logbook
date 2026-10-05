import type { ISqliteDb } from '@log-book/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { everything, seedRows, START } from '../testing/rows'
import { insert, seedWarehouse, type ITestWarehouse } from '../testing/warehouse'
import { MINUTE, SECOND } from '../time'
import type * as Calls from './calls'

// Twenty quick Reads give Read a usual time; one took five minutes.
const seed = (db: ISqliteDb): void => {
  seedRows(db)

  for (let index = 0; index < 20; index += 1) {
    insert(db, 'tool_call', {
      id: `c-quick-${String(index)}`,
      session_id: 'ses-me',
      message_id: 'm-me-2',
      name: 'Read',
      bare_name: 'Read',
      family: 'file',
      input_json: '{}',
      status: 'completed',
      started_at: START + 20 * MINUTE + index * SECOND,
      ended_at: START + 20 * MINUTE + index * SECOND + SECOND,
    })
  }

  insert(db, 'tool_call', {
    id: 'c-slow',
    session_id: 'ses-me',
    message_id: 'm-me-2',
    name: 'Read',
    bare_name: 'Read',
    family: 'file',
    input_json: '{}',
    status: 'completed',
    started_at: START + 25 * MINUTE,
    ended_at: START + 30 * MINUTE,
  })
}

let warehouse: ITestWarehouse
let calls: typeof Calls

beforeAll(async () => {
  warehouse = await seedWarehouse(seed)
  calls = await import('./calls')
})

afterAll(async () => {
  await warehouse.remove()
})

describe('failedCalls', () => {
  it('should list every failed call with its label as the cookbook wrote it', () => {
    const failed = calls.failedCalls(0, Number.MAX_SAFE_INTEGER)

    expect(
      failed.toSorted((left, right) => left.id.localeCompare(right.id)).map((call) => [call.id, call.label])
    ).toEqual([
      ['c-bash-fail', 'command mistake'],
      ['c-edit-1', 'edit mismatch'],
      ['c-edit-2', 'invalid call'],
      ['c-edit-3', null],
      ['c-test-fail', 'real result'],
    ])
  })

  it('should leave out the calls of another range', () => {
    expect(calls.failedCalls(START + 11 * MINUTE, START + 12 * MINUTE).map((call) => call.id)).toEqual(['c-test-fail'])
  })
})

describe('causeCounts', () => {
  it('should count failed calls by cause as shown, leaving out real results', () => {
    expect(calls.causeCounts(0, Number.MAX_SAFE_INTEGER)).toEqual(
      new Map([
        ['Called the tool wrong', 2],
        ["Edit didn't match the file", 1],
        ['Not labelled yet', 1],
      ])
    )
  })
})

describe('failuresWithCause', () => {
  it('should count the failed calls of a cause as shown, whichever labels lead to it', () => {
    expect(calls.failuresWithCause('Called the tool wrong')).toBe(2)
    expect(calls.failuresWithCause('Not labelled yet')).toBe(1)
  })

  it('should count none for a name that is no cause as shown', () => {
    expect(calls.failuresWithCause('Tool bug')).toBe(0)
    expect(calls.failuresWithCause('Made up')).toBe(0)
  })
})

describe('slowCalls', () => {
  it('should group the calls well over their tool usual time by tool', () => {
    const slow = calls.slowCalls(everything())

    expect(slow).toEqual({
      groups: [{ key: 'Read', calls: 1, overMs: 30 * SECOND, usualMs: SECOND, longestMs: 5 * MINUTE }],
      total: 1,
    })
  })

  it('should have a usual time only for a tool with enough timed calls', () => {
    expect(calls.usualTime({ name: 'Read', family: 'file', purpose: null })).toBe(SECOND)
    expect(calls.usualTime({ name: 'Edit', family: 'file', purpose: null })).toBeNull()
  })

  it('should call a call slow only against a usual time, and over the floor', () => {
    const read = { name: 'Read', family: 'file', purpose: null }

    expect(calls.isSlow(read, 5 * MINUTE)).toBe(true)
    expect(calls.isSlow(read, 20 * SECOND)).toBe(false)
    expect(calls.isSlow({ ...read, name: 'Edit' }, 5 * MINUTE)).toBe(false)
    expect(calls.isSlow(read, null)).toBe(false)
  })
})
