import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { addDays, DAY, HOUR, isoDay, MINUTE, pad2, SECOND, startOfDay } from './time'

// Warsaw moves its clocks back on 25 Oct 2026.
beforeAll(() => {
  vi.stubEnv('TZ', 'Europe/Warsaw')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

const local = (year: number, month: number, day: number, hour = 0): number =>
  new Date(year, month - 1, day, hour).getTime()

describe('time', () => {
  it('should build each unit from the one below', () => {
    expect([SECOND, MINUTE, HOUR, DAY]).toEqual([1000, 60_000, 3_600_000, 86_400_000])
  })

  it('should pad a number to two digits', () => {
    expect([pad2(3), pad2(12)]).toEqual(['03', '12'])
  })

  it('should start a day at local midnight', () => {
    expect(startOfDay(local(2026, 10, 3, 15))).toBe(local(2026, 10, 3))
  })

  it('should move by calendar days across a clock change', () => {
    expect(addDays(local(2026, 10, 24), 1)).toBe(local(2026, 10, 25))
    expect(addDays(local(2026, 10, 25), 1) - local(2026, 10, 25)).toBe(25 * HOUR)
    expect(addDays(local(2026, 10, 3, 9), -7)).toBe(local(2026, 9, 26, 9))
  })

  it('should write a local day as YYYY-MM-DD', () => {
    expect(isoDay(local(2026, 1, 5, 23))).toBe('2026-01-05')
  })
})
