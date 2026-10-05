import { plural, wait } from '../format'
import type { IConversationTime } from '../queries/effort'
import { MINUTE } from '../time'
import { GOAL_ROWS, type ITimeRows, rowLabel } from './time-rows'

// Wide enough that minutes of work and days of elapsed time both read.
const FLOOR_MS = MINUTE
const MIN_CEILING_MS = 10 * MINUTE

export const conversationTimeRows = (rows: readonly IConversationTime[]): ITimeRows => {
  const shown = rows.slice(0, 1 + GOAL_ROWS)

  return {
    rows: shown.map((row) => ({
      label: rowLabel(row.goal),
      title: `${rowLabel(row.goal)}, ${plural(row.conversations, 'conversation')}`,
      dot: row.activeMs,
      tick: row.elapsedMs,
      lead: wait(row.activeMs),
      trail: `of ${wait(row.elapsedMs)}`,
    })),
    floor: FLOOR_MS,
    ceiling: Math.max(MIN_CEILING_MS, ...shown.map((row) => row.elapsedMs)),
  }
}
