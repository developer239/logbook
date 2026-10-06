import { describe, expect, it } from 'vitest'
import {
  ago,
  brief,
  change,
  clip,
  count,
  duration,
  elapsed,
  oneInTen,
  pct,
  plural,
  rangeDay,
  stamp,
  tokensCompact,
  tokensK,
  tokensLine,
  turnLabel,
  typical,
  wait,
  when,
} from './format'
import { DAY, HOUR, MINUTE, SECOND } from './time'

const at = (text: string): number => new Date(text).getTime()

describe('format', () => {
  it('should write durations the way people say them, and a missing one in words', () => {
    expect([40, 3_300, 41_000, 141_000, 120_000, 2_580_000, 7_500_000, 7_200_000, null].map(duration)).toEqual([
      '40 ms',
      '3.3 s',
      '41 s',
      '2 min 21 s',
      '2 min',
      '43 min',
      '2 h 5 min',
      '2 h',
      'no time recorded',
    ])
  })

  it('should round a duration up to the next whole unit rather than write 60', () => {
    expect([179_700, 7_170_000].map(duration)).toEqual(['3 min', '2 h'])
  })

  it('should write a typical wait short: seconds, a minute with one decimal, then whole minutes', () => {
    expect([41_000, 84_000, 120_000, 2_580_000, 9_000_000].map(wait)).toEqual([
      '41 s',
      '1.4 min',
      '2 min',
      '43 min',
      '2.5 h',
    ])
  })

  it('should write tokens with one decimal in a step and compactly in a card', () => {
    expect([412, 161_204].map(tokensK)).toEqual(['0.4k', '161.2k'])
    expect([420, 559_600, 79_500_000].map(tokensCompact)).toEqual(['420', '560k', '80M'])
  })

  it('should say a change against the previous period in words', () => {
    expect(change(196, 184, count, 'last week')).toBe('up 12 from last week')
    expect(change(43, 46, (value) => `${String(value)} h`, 'last week')).toBe('down 3 h from last week')
    expect(change(5, 5, count, 'yesterday')).toBe('same as yesterday')
  })

  it('should say when something happened from where now is', () => {
    const now = at('2026-10-02T12:00:00')

    expect(when(at('2026-10-02T08:41:00'), now)).toBe('Today 08:41')
    expect(when(at('2026-10-01T17:02:00'), now)).toBe('Yesterday 17:02')
    expect(when(at('2026-09-30T15:20:00'), now)).toBe('Wed 30, 15:20')
    expect(when(at('2026-09-22T10:00:00'), now)).toBe('Sep 22')
    expect(ago(at('2026-10-02T11:56:00'), now)).toBe('4 min ago')
    expect(ago(at('2026-10-02T11:00:00'), now)).toBe('1 h ago')
  })

  it('should write an elapsed time in whole minutes, hours or days, and a point in time as that ago', () => {
    const now = at('2026-10-02T12:00:00')

    expect(
      [0, 59 * SECOND, 4 * MINUTE, 59 * MINUTE, HOUR, 23 * HOUR, DAY, 3 * DAY].map((ms) => [
        elapsed(ms),
        ago(now - ms, now),
      ])
    ).toEqual([
      ['1 min', '1 min ago'],
      ['1 min', '1 min ago'],
      ['4 min', '4 min ago'],
      ['59 min', '59 min ago'],
      ['1 h', '1 h ago'],
      ['23 h', '23 h ago'],
      ['1 d', '1 d ago'],
      ['3 d', '3 d ago'],
    ])
  })

  it('should take the typical value and the one 1 in 10 exceed, and clip on whole characters', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

    expect([typical(values), oneInTen(values)]).toEqual([6, 10])
    expect(clip('emoji 😀😀😀', 8)).toBe('emoji 😀…')
  })

  it('should write a count with its noun, one of it in the singular', () => {
    expect([plural(1, 'step'), plural(2, 'step'), plural(1200, 'step')]).toEqual(['1 step', '2 steps', '1,200 steps'])
    expect([plural(1, 'query', 'queries'), plural(0, 'query', 'queries')]).toEqual(['1 query', '0 queries'])
  })

  it('should write a fraction as a percentage', () => {
    expect([pct(0.5), pct(1 / 3, 1), pct(0.123456, 3)]).toEqual(['50.00%', '33.3%', '12.346%'])
  })

  it('should label a turn with two digits', () => {
    expect([turnLabel(3), turnLabel(12)]).toEqual(['Turn 03', 'Turn 12'])
  })

  it('should put text on one line and cut it', () => {
    expect(brief('  one\n  two   three ', 40)).toBe('one two three')
    expect(brief('one two three', 6)).toBe('one t…')
  })

  it('should say a request’s tokens, or that none were recorded', () => {
    expect(tokensLine({ tokensRead: 161_204, tokensWritten: 412 })).toBe('161.2k read · 0.4k written')
    expect(tokensLine({ tokensRead: null, tokensWritten: 412 })).toBe('tokens not recorded')
  })

  it('should write a start time as its day and its clock', () => {
    expect(rangeDay(at('2026-09-26T10:00:00'))).toBe('Sat 26 Sep')
    expect(stamp(at('2026-10-01T09:12:00'))).toBe('Thu 1 Oct, 09:12')
  })
})
