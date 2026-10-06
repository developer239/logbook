import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { everything, seedRows } from '../testing/rows'
import { seedWarehouse, type ITestWarehouse } from '../testing/warehouse'
import type * as Steps from './steps'

let warehouse: ITestWarehouse
let steps: typeof Steps

beforeAll(async () => {
  warehouse = await seedWarehouse(seedRows)
  steps = await import('./steps')
})

afterAll(async () => {
  await warehouse.remove()
})

const ask = (query: string): ReturnType<typeof Steps.steps> =>
  steps.steps(steps.parseStepsQuery(new URLSearchParams(query)), everything(), 0)

const idsOf = (query: string): string[] =>
  ask(query)
    .rows.map((row) => row.id)
    .toSorted()

describe('steps', () => {
  it('should list every call of the range, the newest first, with where it happened', () => {
    const { rows, total, pageSize } = ask('')

    expect(total).toBe(9)
    expect(pageSize).toBe(100)
    expect(rows[0]).toEqual({
      id: 'c-notes',
      sessionId: 'ses-me',
      title: 'Fix the widget',
      turnId: 'm-me-4',
      name: 'notes_add',
      family: 'mcp:opencode',
      status: 'completed',
      inputJson: '{"text":"hi"}',
      at: expect.any(Number) as number,
      durationMs: 1000,
      purpose: null,
      cause: null,
      usualMs: null,
    })
  })

  it('should give a call without a time of its own its message time and no duration', () => {
    const search = ask('').rows.find((row) => row.id === 'c-search')

    expect(search).toMatchObject({ name: 'ToolSearch', durationMs: null, usualMs: null })
  })

  it('should list the failed calls that were a problem, with their cause as shown', () => {
    const { rows } = ask('failed=1')

    expect(rows.toSorted((left, right) => left.id.localeCompare(right.id)).map((row) => [row.id, row.cause])).toEqual([
      ['c-bash-fail', 'Called the tool wrong'],
      ['c-edit-1', "Edit didn't match the file"],
      ['c-edit-2', 'Called the tool wrong'],
      ['c-edit-3', 'Not labelled yet'],
    ])
  })

  it('should list the failures that were real results apart', () => {
    expect(idsOf('real=1')).toEqual(['c-test-fail'])
  })

  it('should list the failed calls of one cause as shown', () => {
    expect(idsOf('cause=Called+the+tool+wrong')).toEqual(['c-bash-fail', 'c-edit-2'])
  })

  it('should list the calls in a retry loop', () => {
    expect(idsOf('loop=1')).toEqual(['c-edit-1', 'c-edit-2', 'c-edit-3'])
  })

  it('should list the calls of one tool in any case or MCP prefix', () => {
    expect(idsOf('tool=NOTES_ADD')).toEqual(['c-notes'])
    expect(idsOf('tool=bash')).toEqual(['c-bash-fail', 'c-test-fail'])
  })

  it('should list no slow call where no tool has a usual time', () => {
    expect(ask('slow=Edit')).toMatchObject({ rows: [], total: 0 })
  })

  it('should list nothing for a page past the end', () => {
    expect(steps.steps(steps.parseStepsQuery(new URLSearchParams('')), everything(), 3)).toMatchObject({
      rows: [],
      total: 9,
    })
  })

  it('should refuse a flag that is not 1', () => {
    expect(() => steps.parseStepsQuery(new URLSearchParams('failed=yes'))).toThrow('failed takes 1, got yes')
  })
})
