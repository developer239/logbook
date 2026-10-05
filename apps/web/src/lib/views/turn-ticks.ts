import { oneDecimal } from '../format'
import { HOUR, MINUTE, SECOND } from '../time'

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18_000, 36_000, 86_400].map(
  (seconds) => seconds * SECOND
)

interface ITick {
  atMs: number
  label: string
}

export interface ITurnTicks {
  spanMs: number
  stepMs: number
  ticks: ITick[]
}

export const turnTicks = (turnSpanMs: number): ITurnTicks => {
  const spanMs = Math.max(turnSpanMs, SECOND)
  const stepMs = TICK_STEPS.find((step) => spanMs / step <= 5) ?? spanMs
  const [unit, unitMs] = stepMs >= HOUR ? ['h', HOUR] : stepMs >= MINUTE ? ['min', MINUTE] : ['s', SECOND]
  const atMs = Array.from({ length: Math.floor(spanMs / stepMs) + 1 }, (_, index) => index * stepMs)

  return {
    spanMs,
    stepMs,
    ticks: atMs.map((at, index) => ({
      atMs: at,
      label: `${oneDecimal(at / unitMs)}${index === atMs.length - 1 ? ` ${unit}` : ''}`,
    })),
  }
}
