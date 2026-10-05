import { describe, expect, it } from 'vitest'
import { logScale } from './scale'

describe('logScale', () => {
  const scale = logScale(10, 1000)

  it('should put the floor at 0 and the ceiling at 1', () => {
    expect(scale(10)).toBe(0)
    expect(scale(1000)).toBe(1)
  })

  it('should put equal ratios an equal distance apart', () => {
    expect(scale(100)).toBeCloseTo(0.5)
    expect(scale(31.6227766)).toBeCloseTo(0.25)
  })

  it('should keep a value below the floor at the floor', () => {
    expect(scale(1)).toBe(0)
    expect(scale(0)).toBe(0)
  })
})
