import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseRange } from '../range'
import { seedRows, START } from '../testing/rows'
import { seedWarehouse, type ITestWarehouse } from '../testing/warehouse'
import type * as Interaction from './interaction'

let warehouse: ITestWarehouse
let queries: typeof Interaction

beforeAll(async () => {
  warehouse = await seedWarehouse(seedRows)
  queries = await import('./interaction')
})

afterAll(async () => {
  await warehouse.remove()
})

describe('agentReactions', () => {
  it("should give each model's share of replies with each code in the range and by week, from the newest labelling of each reply", () => {
    const range = parseRange(new URLSearchParams('range=7d'), START + 24 * 60 * 60 * 1000)
    const quiet = Array.from({ length: queries.TREND_WEEKS - 1 }, () => 0)

    expect(queries.agentReactions(range)).toEqual([
      {
        model: 'model-a',
        replies: 2,
        reactions: [
          { kind: 'permission', count: 1, weekly: [...quiet, 0.5] },
          { kind: 'caves', count: 0, weekly: [...quiet, 0] },
          { kind: 'pushback', count: 1, weekly: [...quiet, 0.5] },
        ],
      },
      {
        model: 'model-b',
        replies: 1,
        reactions: queries.REPLY_HABITS.map((kind) => ({ kind, count: 0, weekly: [...quiet, 0] })),
      },
    ])
  })

  it('should leave out a model with no replies in the range', () => {
    const range = parseRange(new URLSearchParams('range=today'), START + 7 * 24 * 60 * 60 * 1000)

    expect(queries.agentReactions(range)).toEqual([])
  })
})

describe('reactionTrend', () => {
  it("should give each kind's share of the labelled prompts in the range and of each of the weeks up to its end", () => {
    const range = parseRange(new URLSearchParams('range=7d'), START + 24 * 60 * 60 * 1000)
    const quiet = Array.from({ length: queries.TREND_WEEKS - 1 }, () => 0)

    expect(queries.reactionTrend(range)).toEqual({
      prompts: 2,
      reactions: [
        { kind: 'correction', count: 1, weekly: [...quiet, 0.5] },
        { kind: 'pushback', count: 0, weekly: [...quiet, 0] },
        { kind: 'praise', count: 1, weekly: [...quiet, 0.5] },
      ],
    })
  })

  it('should keep the weeks before a range that starts after the reactions', () => {
    const range = parseRange(new URLSearchParams('range=today'), START + 7 * 24 * 60 * 60 * 1000)

    expect(queries.reactionTrend(range).reactions[0]).toEqual({
      kind: 'correction',
      count: 0,
      weekly: [...Array.from({ length: queries.TREND_WEEKS - 2 }, () => 0), 0.5, 0],
    })
  })
})
