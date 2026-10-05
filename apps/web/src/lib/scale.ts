export const logScale = (floor: number, ceiling: number): ((value: number) => number) => {
  const span = Math.log(ceiling / floor)
  return (value) => Math.log(Math.max(value, floor) / floor) / span
}
