const THOUSANDS = /\B(?=(?:\d{3})+(?!\d))/gu
const MB = 1_000_000
const GB = 1_000_000_000
const SECOND_MS = 1000
const MINUTE_S = 60
const HOUR_S = 3600
const ONE_DECIMAL_BELOW_S = 10

// A count with a thousands separator: 1,010.
export const formatCount = (count: number): string => String(count).replaceAll(THOUSANDS, ',')

// In MB below 1 GB, else in GB with one decimal: 261 MB, 1.3 GB.
export const formatSize = (bytes: number): string =>
  bytes < GB ? `${formatCount(Math.round(bytes / MB))} MB` : `${(bytes / GB).toFixed(1)} GB`

const minutesAndSeconds = (seconds: number): string => {
  const minutes = Math.floor(seconds / MINUTE_S)
  const rest = Math.round(seconds - minutes * MINUTE_S)
  return rest === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(rest)} s`
}

const hoursAndMinutes = (seconds: number): string => {
  const hours = Math.floor(seconds / HOUR_S)
  const minutes = Math.round((seconds - hours * HOUR_S) / MINUTE_S)
  return minutes === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes)} min`
}

// Below 10 seconds with one decimal (1.4 s), below a minute in whole seconds (31 s), below an hour in minutes with
// seconds when not zero (2 min 10 s), then in hours and minutes (2 h 5 min).
export const formatDuration = (milliseconds: number): string => {
  const seconds = milliseconds / SECOND_MS
  if (seconds < ONE_DECIMAL_BELOW_S) {
    return `${seconds.toFixed(1)} s`
  }
  if (seconds < MINUTE_S) {
    return `${String(Math.round(seconds))} s`
  }
  return seconds < HOUR_S ? minutesAndSeconds(seconds) : hoursAndMinutes(seconds)
}

// A path with the home directory shown as `~`.
export const tildePath = (path: string, home: string): string => {
  if (path === home) {
    return '~'
  }
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}
