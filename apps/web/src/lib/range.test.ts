import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ParamError } from './errors'
import { parseRange } from './range'
import { HOUR } from './time'

// Warsaw moves its clocks back on 25 Oct 2026 and forward on 29 Mar 2026.
beforeAll(() => {
  vi.stubEnv('TZ', 'Europe/Warsaw')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

const local = (year: number, month: number, day: number, hour = 0): number =>
  new Date(year, month - 1, day, hour).getTime()

describe('parseRange', () => {
  it('should refuse a day the calendar does not have', () => {
    expect(() => parseRange(new URLSearchParams('from=2026-02-30&to=2026-03-03'))).toThrow(ParamError)
  })

  it('should end a custom range at midnight across a clock change', () => {
    const range = parseRange(new URLSearchParams('from=2026-10-25&to=2026-10-25'))

    expect(range.to - range.from).toBe(25 * HOUR)
    expect(range.to).toBe(local(2026, 10, 26))
  })

  it('should compare a preset with the previous period up to the same time', () => {
    const now = local(2026, 10, 3, 11)

    const range = parseRange(new URLSearchParams('range=today'), now)

    expect(range.previous).toEqual({ from: local(2026, 10, 2), to: local(2026, 10, 2, 11) + 1 })
  })

  it('should step a week back by calendar days across a clock change', () => {
    const now = local(2026, 10, 28, 9)

    const range = parseRange(new URLSearchParams('range=7d'), now)

    expect(range.from).toBe(local(2026, 10, 22))
    expect(range.previous?.from).toBe(local(2026, 10, 15))
  })

  it('should show all time from the start with nothing before it to compare with', () => {
    const now = local(2026, 10, 3, 11)

    const range = parseRange(new URLSearchParams('range=all'), now)

    expect(range).toMatchObject({ key: 'all', from: 0, to: now + 1, previous: null, label: 'All time' })
    expect(range.params).toEqual({ range: 'all' })
  })

  it('should keep a range on a link by the parameters that name it', () => {
    expect(parseRange(new URLSearchParams()).params).toEqual({ range: '7d' })
    expect(parseRange(new URLSearchParams('from=2026-10-01&to=2026-10-03')).params).toEqual({
      from: '2026-10-01',
      to: '2026-10-03',
    })
  })

  it('should refuse a range that is not one it offers, including a name every object has', () => {
    expect(() => parseRange(new URLSearchParams('range=year'))).toThrow(ParamError)
    expect(() => parseRange(new URLSearchParams('range=toString'))).toThrow(ParamError)
  })
})
