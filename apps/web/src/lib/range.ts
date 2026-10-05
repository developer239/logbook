import { ParamError } from './errors'
import { rangeDay } from './format'
import { addDays, DAY, isoDay, startOfDay } from './time'

export const PRESETS = {
  'today': { days: 1, since: 'yesterday', name: 'Today' },
  '7d': { days: 7, since: 'last week', name: '7 days' },
  '30d': { days: 30, since: 'the previous 30 days', name: '30 days' },
  'all': { days: null, since: '', name: 'All' },
} as const

type PresetKey = keyof typeof PRESETS

const isPreset = (key: string): key is PresetKey => Object.hasOwn(PRESETS, key)

// A link to another range drops the page number too, as it has other pages.
export const RANGE_PARAMS: readonly string[] = ['range', 'from', 'to', 'page']

export interface IRange {
  key: PresetKey | 'custom'
  from: number
  // Exclusive.
  to: number
  previous: { from: number; to: number } | null
  since: string
  label: string
  params: Readonly<Record<string, string>>
}

// A day the calendar does not have rolls over (2026-02-30 is March 2), so it
// is refused.
const parseDay = (value: string, name: string): number => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  const date = match === null ? null : new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (date === null || isoDay(date.getTime()) !== value) {
    throw new ParamError(`${name} must be a day as YYYY-MM-DD, got ${value}`)
  }

  return date.getTime()
}

export const parseRange = (params: URLSearchParams, now: number = Date.now()): IRange => {
  const fromParam = params.get('from')
  const toParam = params.get('to')

  if (fromParam !== null || toParam !== null) {
    const from = parseDay(fromParam ?? '', 'from')
    const last = parseDay(toParam ?? '', 'to')

    if (last < from) {
      throw new ParamError('to must be on or after from')
    }

    const to = addDays(last, 1)
    const days = Math.round((to - from) / DAY)

    return {
      key: 'custom',
      from,
      to,
      previous: { from: addDays(from, -days), to: from },
      since: `the previous ${String(days)} days`,
      label: `${rangeDay(from)} – ${rangeDay(last)}`,
      params: { from: isoDay(from), to: isoDay(last) },
    }
  }

  const key = params.get('range') ?? '7d'

  if (!isPreset(key)) {
    throw new ParamError(`range must be today, 7d, 30d or all, got ${key}`)
  }

  const preset = PRESETS[key]

  if (preset.days === null) {
    return { key, from: 0, to: now + 1, previous: null, since: preset.since, label: 'All time', params: { range: key } }
  }

  const from = addDays(startOfDay(now), -(preset.days - 1))
  const to = now + 1

  return {
    key,
    from,
    to,
    // As far into the previous period as this one has gone: today until now
    // against yesterday until this time, not all of yesterday.
    previous: { from: addDays(from, -preset.days), to: addDays(to, -preset.days) },
    since: preset.since,
    label:
      preset.days === 1
        ? `${preset.name} · ${rangeDay(from)}`
        : `${preset.name} · ${rangeDay(from)} – ${rangeDay(now)}`,
    params: { range: key },
  }
}
