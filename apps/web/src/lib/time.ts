export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

export const pad2 = (value: number): string => String(value).padStart(2, '0')

export const startOfDay = (at: number): number => {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

// A time moved by whole local days: a day across a clock change is 23 or 25 hours.
export const addDays = (at: number, days: number): number => {
  const date = new Date(at)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

// Weeks start on Monday.
export const startOfWeek = (at: number): number => {
  const day = startOfDay(at)
  return addDays(day, -((new Date(day).getDay() + 6) % 7))
}

export const isoDay = (at: number): string => {
  const date = new Date(at)
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}
