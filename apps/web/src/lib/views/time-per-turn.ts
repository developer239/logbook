import { plural, wait } from '../format'
import type { ITurnWait } from '../queries/effort'
import { SECOND } from '../time'
import { GOAL_ROWS, type ITimeRows, rowLabel } from './time-rows'

// Wide enough that a 41 s turn and a 43 min one both read.
const FLOOR_MS = 10 * SECOND
const MIN_CEILING_MS = 60 * SECOND

export const turnTimeRows = (rows: readonly ITurnWait[]): ITimeRows => {
  const shown = rows.slice(0, 1 + GOAL_ROWS)

  return {
    rows: shown.map((row) => ({
      label: rowLabel(row.goal),
      title: rowLabel(row.goal),
      dot: row.typicalMs,
      tick: row.oneInTenMs,
      lead: wait(row.typicalMs),
      trail: `· ${row.oneInTenMs === null ? plural(row.turns, 'turn') : `over ${wait(row.oneInTenMs)}`}`,
    })),
    floor: FLOOR_MS,
    ceiling: Math.max(MIN_CEILING_MS, ...shown.map((row) => row.oneInTenMs ?? row.typicalMs)),
  }
}

const SHARES = [
  [0.25, 'about a quarter'],
  [1 / 3, 'about a third'],
  [0.5, 'about half'],
  [2 / 3, 'about two thirds'],
  [0.75, 'about three quarters'],
] as const

const LITTLE = 0.15
const MOST = 0.85

export const shareWords = (share: number): string => {
  if (share < LITTLE) {
    return 'little'
  }
  if (share > MOST) {
    return 'most'
  }

  return SHARES.reduce((best, entry) => (Math.abs(entry[0] - share) < Math.abs(best[0] - share) ? entry : best))[1]
}
