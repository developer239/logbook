import { describe, expect, it } from 'vitest'
import type { ITurnWait } from '../queries/effort'
import { MINUTE, SECOND } from '../time'
import { shareWords, turnTimeRows } from './time-per-turn'
import { GOAL_ROWS } from './time-rows'

const turn = (fields: Partial<ITurnWait>): ITurnWait => ({
  goal: null,
  turns: 30,
  typicalMs: 41 * SECOND,
  oneInTenMs: 43 * MINUTE,
  ...fields,
})

describe('turnTimeRows', () => {
  it('should put the typical wait as the dot and the 1 in 10 wait as the tick', () => {
    const { rows } = turnTimeRows([turn({})])

    expect(rows).toEqual([
      {
        label: 'All',
        title: 'All',
        dot: 41 * SECOND,
        tick: 43 * MINUTE,
        lead: '41 s',
        trail: '· over 43 min',
      },
    ])
  })

  it('should say how many turns stand behind a goal too short for a 1 in 10 wait', () => {
    const { rows } = turnTimeRows([turn({}), turn({ goal: 'fix a bug', turns: 6, oneInTenMs: null })])

    expect(rows[1]).toMatchObject({ label: 'Fixing bugs', tick: null, trail: '· 6 turns' })
  })

  it('should run the scale from 10 s to the longest wait shown, and at least a minute', () => {
    expect(turnTimeRows([turn({ oneInTenMs: null })])).toMatchObject({ floor: 10 * SECOND, ceiling: MINUTE })
    expect(turnTimeRows([turn({ oneInTenMs: 90 * MINUTE })]).ceiling).toBe(90 * MINUTE)
  })

  it('should show the row of all and the first goals, and leave the longest wait of the rest out of the scale', () => {
    const goals = Array.from({ length: GOAL_ROWS + 2 }, (_, index) =>
      turn({ goal: `goal ${String(index)}`, oneInTenMs: (index + 1) * MINUTE })
    )
    const { rows, ceiling } = turnTimeRows([turn({ oneInTenMs: MINUTE }), ...goals])

    expect(rows).toHaveLength(1 + GOAL_ROWS)
    expect(ceiling).toBe(GOAL_ROWS * MINUTE)
  })
})

describe('shareWords', () => {
  it('should say a small share is little and a large one most', () => {
    expect([0, 0.14, 0.86, 1].map(shareWords)).toEqual(['little', 'little', 'most', 'most'])
  })

  it('should say the nearest of the common fractions in between', () => {
    expect([0.2, 0.34, 0.5, 0.6, 0.7, 0.8].map(shareWords)).toEqual([
      'about a quarter',
      'about a third',
      'about half',
      'about two thirds',
      'about two thirds',
      'about three quarters',
    ])
  })
})
