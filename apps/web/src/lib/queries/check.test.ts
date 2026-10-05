import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { everything, seedRows, START } from '../testing/rows'
import { seedWarehouse, type ITestWarehouse } from '../testing/warehouse'
import type * as Check from './check'

let warehouse: ITestWarehouse
let queries: typeof Check

beforeAll(async () => {
  warehouse = seedWarehouse(seedRows)
  queries = await import('./check')
})

afterAll(() => {
  warehouse.remove()
})

describe('spotCheck', () => {
  it('should offer the reactions not judged for the labelling shown, with their prompt and the reply before it', () => {
    const check = queries.spotCheck(everything())

    expect(check.items.toSorted((left, right) => left.reactionId.localeCompare(right.reactionId))).toEqual([
      {
        reactionId: 'm-me-4#1',
        sessionId: 'ses-me',
        messageId: 'm-me-4',
        reaction: 'teaching',
        target: null,
        reach: null,
        quote: null,
        rule: null,
        prompt: 'No, use the other widget',
        reply: 'Done',
      },
      {
        reactionId: 'm-me-4#3',
        sessionId: 'ses-me',
        messageId: 'm-me-4',
        reaction: 'praise',
        target: 'design',
        reach: null,
        quote: 'nice layout',
        rule: null,
        prompt: 'No, use the other widget',
        reply: 'Done',
      },
    ])
    expect(check.unjudged).toBe(2)
    expect(check.agreement).toEqual([{ reaction: 'correction', right: 1, wrong: 0 }])
  })

  it('should offer the same sample on every visit', () => {
    expect(queries.spotCheck(everything()).items.map((item) => item.reactionId)).toEqual(
      queries.spotCheck(everything()).items.map((item) => item.reactionId)
    )
  })

  it('should leave out reactions before the range', () => {
    const later = { ...everything(), from: START + 365 * 24 * 60 * 60 * 1000 }

    expect(queries.spotCheck(later)).toEqual({ items: [], unjudged: 0, agreement: [] })
  })
})
