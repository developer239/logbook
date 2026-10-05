import { describe, expect, it } from 'vitest'
import { sparkline } from './sparkline'

describe('sparkline', () => {
  it('should spread the values across the width, the peak at the top and a zero on the baseline', () => {
    const line = sparkline([0, 7, 14, 7, 0, 0, 14])

    expect(line.points).toBe('2.0,16.0 14.0,9.0 26.0,2.0 38.0,9.0 50.0,16.0 62.0,16.0 74.0,2.0')
    expect(line.last).toEqual([74, 2])
  })

  it('should keep all zeros flat instead of dividing by nothing', () => {
    expect(sparkline([0, 0, 0]).points).toBe('2.0,16.0 38.0,16.0 74.0,16.0')
  })

  it('should take fractions as they are, since only the peak sets the scale', () => {
    expect(sparkline([0.05, 0.1]).points).toBe('2.0,9.0 74.0,2.0')
  })

  it('should have no last point for no values', () => {
    expect(sparkline([])).toEqual({ points: '', last: null })
  })
})
