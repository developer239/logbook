import { HOUR } from './time'

// A night away would squeeze the day's turns into a corner of the map.
const MAX_GAP_MS = HOUR

interface IMapSpan {
  start: number
  end: number
}

export interface IMapPlace<TTurn> {
  turn: TTurn
  byTime: IMapSpan
  byTurn: IMapSpan
}

export const mapPlaces = <TTurn extends { startedAt: number; durationMs: number }>(
  turns: readonly TTurn[]
): IMapPlace<TTurn>[] => {
  const placed: { turn: TTurn; start: number }[] = []
  let at = 0

  for (const [index, turn] of turns.entries()) {
    placed.push({ turn, start: at })
    const next = turns[index + 1]
    const gap = next === undefined ? 0 : next.startedAt - (turn.startedAt + turn.durationMs)
    at += turn.durationMs + Math.min(Math.max(gap, 0), MAX_GAP_MS)
  }

  const total = Math.max(at, 1)

  return placed.map(({ turn, start }, index) => ({
    turn,
    byTime: { start: start / total, end: (start + turn.durationMs) / total },
    byTurn: { start: index / turns.length, end: (index + 1) / turns.length },
  }))
}
