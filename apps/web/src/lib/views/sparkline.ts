// Drawn in an SVG 76 wide and 18 high, the points spread evenly across it.
const LEFT = 2
const WIDTH = 72
const BASELINE = 16
const HEIGHT = 14

export interface ISparkline {
  points: string
  last: [number, number] | null
}

export const sparkline = (values: readonly number[]): ISparkline => {
  const highest = Math.max(0, ...values)
  const peak = highest === 0 ? 1 : highest
  const step = values.length > 1 ? WIDTH / (values.length - 1) : 0
  const coordinates = values.map((value, index): [number, number] => [
    LEFT + index * step,
    BASELINE - (value / peak) * HEIGHT,
  ])

  return {
    points: coordinates.map(([xCoord, yCoord]) => `${xCoord.toFixed(1)},${yCoord.toFixed(1)}`).join(' '),
    last: coordinates.at(-1) ?? null,
  }
}
