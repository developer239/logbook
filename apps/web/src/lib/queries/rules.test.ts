import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { everything, seedRows, START } from '../testing/rows'
import { seedWarehouse, type ITestWarehouse } from '../testing/warehouse'
import type * as Rules from './rules'

let warehouse: ITestWarehouse
let queries: typeof Rules

beforeAll(async () => {
  warehouse = seedWarehouse(seedRows)
  queries = await import('./rules')
})

afterAll(() => {
  warehouse.remove()
})

describe('rules', () => {
  it('should list each rule group said in the range with its coverage and every time it was said', () => {
    expect(queries.rules(everything())).toEqual([
      {
        id: 'rule:1',
        text: 'Use the widget the user names.',
        coverage: 'missing',
        source: null,
        sayings: [
          {
            ruleId: 'rule:1',
            sessionId: 'ses-me',
            messageId: 'm-me-4',
            reaction: 'correction',
            quote: 'use the other widget',
            at: expect.any(Number) as number,
            project: expect.any(String) as string,
          },
        ],
      },
    ])
  })

  it('should list what the human praised, the newest first', () => {
    expect(queries.praise(everything())).toEqual([
      {
        sessionId: 'ses-me',
        messageId: 'm-me-4',
        target: 'design',
        quote: 'nice layout',
        at: expect.any(Number) as number,
        title: expect.any(String) as string,
      },
    ])
  })

  it('should leave out what was said before the range', () => {
    const later = { ...everything(), from: START + 365 * 24 * 60 * 60 * 1000 }

    expect([queries.rules(later), queries.praise(later)]).toEqual([[], []])
  })
})
