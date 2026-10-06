import { describe, expect, it } from 'vitest'
import type { IStrip } from '../queries/strip'
import { parseRange } from '../range'
import { type IStat, stripStats } from './strip'

const range = parseRange(new URLSearchParams('range=7d'), new Date(2026, 9, 3, 12).getTime())

const strip = (fields: Partial<IStrip>): IStrip => ({
  conversations: 10,
  by: { me: 6, agent: 3, script: 1 },
  activeMs: 3_600_000,
  done: 5,
  calls: 200,
  failed: 14,
  realResults: 4,
  ...fields,
})

const stat = (label: string, current: IStrip, previous: IStrip | null, isLabelled = true): IStat => {
  const found = stripStats(range, current, previous, isLabelled).find((entry) => entry.label === label)
  if (found === undefined) {
    throw new Error(`No stat ${label}`)
  }

  return found
}

describe('stripStats', () => {
  it('should say who started the conversations', () => {
    expect(stat('Conversations', strip({}), null).sub).toBe('6 by me, 3 by agents, 1 by scripts')
  })

  it('should count the calls that went wrong without the real results, and mark them a problem', () => {
    const wrong = stat('Calls that went wrong', strip({}), null)

    expect(wrong.value).toBe('10')
    expect(wrong.sub).toBe('5% of 200 calls, 4 real results left out')
    expect(wrong.tone).toBe('problem')
    expect(stat('Calls that went wrong', strip({ failed: 4 }), null).tone).toBe('')
  })

  it('should compare done and wrong as shares of what a busier period has more of', () => {
    const before = strip({ conversations: 5, done: 1, calls: 100, failed: 4, realResults: 0 })

    expect(stat('Finished', strip({}), before).change).toBe('up 30 pts from last week')
    expect(stat('Finished', strip({}), before).isUp).toBe(true)
    expect(stat('Calls that went wrong', strip({}), before).change).toBe('up 1 pts from last week')
  })

  it('should have no change without a previous period, and say so where there is nothing to share', () => {
    expect(stat('Conversations', strip({}), null).change).toBeNull()
    expect(stat('Finished', strip({ conversations: 0, done: 0 }), null).sub).toBe('no conversations')
    expect(stat('Calls that went wrong', strip({ calls: 0, failed: 0, realResults: 0 }), null).sub).toBe('no calls')
  })

  it('should show no finished share until a model has labelled outcomes, and keep the calls that went wrong', () => {
    const before = strip({ conversations: 5, done: 1 })

    expect({
      finished: stat('Finished', strip({}), before, false),
      wrong: stat('Calls that went wrong', strip({}), before, false).value,
    }).toStrictEqual({
      finished: {
        label: 'Finished',
        value: null,
        href: '/conversations?q=outcome%3Adone&range=7d',
        sub: 'not labelled yet',
        change: null,
        isUp: false,
        tone: '',
      },
      wrong: '10',
    })
  })

  it('should link each figure to what it counts', () => {
    const hrefs = stripStats(range, strip({}), null, true).map((entry) => entry.href)

    expect(hrefs).toEqual([
      '/conversations?range=7d',
      '/conversations?range=7d',
      '/conversations?q=outcome%3Adone&range=7d',
      '/steps?failed=1&range=7d',
    ])
  })
})
