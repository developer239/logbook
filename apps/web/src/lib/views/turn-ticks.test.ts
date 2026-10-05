import { describe, expect, it } from 'vitest'
import { HOUR, MINUTE, SECOND } from '../time'
import { turnTicks } from './turn-ticks'

describe('turnTicks', () => {
  it('should tick a turn of a few minutes at round minutes and name the unit once', () => {
    const { stepMs, ticks } = turnTicks(4 * MINUTE + 10 * SECOND)

    expect(stepMs).toBe(MINUTE)
    expect(ticks.map((tick) => tick.label)).toEqual(['0', '1', '2', '3', '4 min'])
    expect(ticks.map((tick) => tick.atMs)).toEqual([0, MINUTE, 2 * MINUTE, 3 * MINUTE, 4 * MINUTE])
  })

  it('should cover at least a second', () => {
    const { spanMs, ticks } = turnTicks(0)

    expect(spanMs).toBe(SECOND)
    expect(ticks.map((tick) => tick.label)).toEqual(['0', '1 s'])
  })

  it('should tick a long turn in hours', () => {
    const { stepMs, ticks } = turnTicks(14 * HOUR)

    expect(stepMs).toBe(5 * HOUR)
    expect(ticks.map((tick) => tick.label)).toEqual(['0', '5', '10 h'])
  })

  it('should say a step under a minute in seconds', () => {
    const { ticks } = turnTicks(40 * SECOND)

    expect(ticks.at(-1)?.label).toBe('40 s')
  })
})
