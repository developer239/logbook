// A missing value is said in words, never as 0 or a dash.

import { DAY, HOUR, MINUTE, pad2, SECOND, startOfDay } from './time'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

export const count = (value: number): string => value.toLocaleString('en-US')

export const plural = (value: number, noun: string, many = `${noun}s`): string =>
  `${count(value)} ${value === 1 ? noun : many}`

export const oneDecimal = (value: number): string => String(Number(value.toFixed(1)))

export const pct = (fraction: number, decimals = 2): string => `${(100 * fraction).toFixed(decimals)}%`

export const turnLabel = (number: number): string => `Turn ${pad2(number)}`

const twoPart = (ms: number, big: number, small: number, bigUnit: string, smallUnit: string): string => {
  const bigs = Math.floor(ms / big)
  const smalls = Math.round((ms - bigs * big) / small)

  if (smalls === 0 || smalls * small === big) {
    return `${String(bigs + (smalls === 0 ? 0 : 1))} ${bigUnit}`
  }

  return `${String(bigs)} ${bigUnit} ${String(smalls)} ${smallUnit}`
}

export const duration = (ms: number | null): string => {
  if (ms === null) {
    return 'no time recorded'
  }
  if (ms < SECOND) {
    return `${String(Math.round(ms))} ms`
  }
  if (ms < 10 * SECOND) {
    return `${(ms / SECOND).toFixed(1)} s`
  }
  if (ms < MINUTE) {
    return `${String(Math.round(ms / SECOND))} s`
  }
  if (ms < 10 * MINUTE) {
    return twoPart(ms, MINUTE, SECOND, 'min', 's')
  }
  if (ms < HOUR) {
    return `${String(Math.round(ms / MINUTE))} min`
  }

  return twoPart(ms, HOUR, MINUTE, 'h', 'min')
}

export const wait = (ms: number): string => {
  if (ms < MINUTE) {
    return `${String(Math.round(ms / SECOND))} s`
  }
  if (ms < 10 * MINUTE) {
    return `${oneDecimal(ms / MINUTE)} min`
  }
  if (ms < HOUR) {
    return `${String(Math.round(ms / MINUTE))} min`
  }

  return `${oneDecimal(ms / HOUR)} h`
}

export const hours = (ms: number): string =>
  ms < 10 * HOUR ? `${oneDecimal(ms / HOUR)} h` : `${String(Math.round(ms / HOUR))} h`

export const percent = (value: number): string =>
  value < 10 ? `${oneDecimal(value)}%` : `${String(Math.round(value))}%`

export const points = (value: number): string => `${value < 10 ? oneDecimal(value) : String(Math.round(value))} pts`

export const tokensK = (value: number): string => `${(value / 1000).toFixed(1)}k`

export const tokensLine = (step: { tokensRead: number | null; tokensWritten: number | null }): string =>
  step.tokensRead === null
    ? 'tokens not recorded'
    : `${tokensK(step.tokensRead)} read · ${tokensK(step.tokensWritten ?? 0)} written`

export const tokensCompact = (value: number): string => {
  if (value < 1000) {
    return String(Math.round(value))
  }

  return value < 1_000_000 ? `${String(Math.round(value / 1000))}k` : `${String(Math.round(value / 1_000_000))}M`
}

export const change = (current: number, previous: number, unit: (value: number) => string, since: string): string => {
  const difference = current - previous

  if (difference === 0) {
    return `same as ${since}`
  }

  return `${difference > 0 ? 'up' : 'down'} ${unit(Math.abs(difference))} from ${since}`
}

const weekday = (at: number): string => WEEKDAYS[new Date(at).getDay()] ?? ''

export const time = (at: number): string => {
  const date = new Date(at)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

export const when = (at: number, now: number = Date.now()): string => {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY)

  if (days === 0) {
    return `Today ${time(at)}`
  }
  if (days === 1) {
    return `Yesterday ${time(at)}`
  }
  if (days < 7) {
    return `${weekday(at)} ${String(new Date(at).getDate())}, ${time(at)}`
  }

  return day(at, now)
}

const day = (at: number, now: number = Date.now()): string => {
  const date = new Date(at)
  const label = `${MONTHS[date.getMonth()] ?? ''} ${String(date.getDate())}`
  return date.getFullYear() === new Date(now).getFullYear() ? label : `${label} ${String(date.getFullYear())}`
}

export const rangeDay = (at: number): string => {
  const date = new Date(at)
  return `${weekday(at)} ${String(date.getDate())} ${MONTHS[date.getMonth()] ?? ''}`
}

export const stamp = (at: number): string => `${rangeDay(at)}, ${time(at)}`

// An elapsed time as the Sync and Label controls write it: whole minutes under an hour, at least 1; whole hours under
// a day; whole days from then on.
export const elapsed = (ms: number): string => {
  const value = Math.max(0, ms)

  if (value < HOUR) {
    return `${String(Math.max(1, Math.floor(value / MINUTE)))} min`
  }

  return value < DAY ? `${String(Math.floor(value / HOUR))} h` : `${String(Math.floor(value / DAY))} d`
}

export const ago = (at: number, now: number = Date.now()): string => `${elapsed(now - at)} ago`

export const clip = (text: string, max: number): string => {
  const characters = Array.from(text)
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join('')}…`
}

export const brief = (text: string, max: number): string => clip(text.replace(/\s+/gu, ' ').trim(), max)

export const typical = (values: readonly number[]): number => quantile(values, 0.5)

export const oneInTen = (values: readonly number[]): number => quantile(values, 0.9)

const quantile = (values: readonly number[], share: number): number => {
  const sorted = [...values].toSorted((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0
}
