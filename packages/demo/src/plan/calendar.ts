export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

// The start of the UTC calendar day `dayIndex` of a span of `days` days whose last day holds the anchor.
export const dayStart = (anchor: number, dayIndex: number, days: number): number => {
  const anchorDay = anchor - (((anchor % DAY_MS) + DAY_MS) % DAY_MS)
  return anchorDay - (days - 1 - dayIndex) * DAY_MS
}
