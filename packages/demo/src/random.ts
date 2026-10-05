import { createHash } from 'node:crypto'

// sfc32 rounds discarded after seeding, so the first draws do not echo the seed's bytes.
const WARM_UP_ROUNDS = 12
const UINT32 = 2 ** 32

export interface IRandomStream {
  // A number in [0, 1).
  next: () => number
  // An integer from min to max, both included.
  integer: (min: number, max: number) => number
  pick: <TItem>(items: readonly TItem[]) => TItem
  // A pick weighted by each entry's weight.
  weightedPick: <TItem>(entries: readonly (readonly [TItem, number])[]) => TItem
  // A new array in a shuffled order; the input is left as it is.
  shuffle: <TItem>(items: readonly TItem[]) => TItem[]
}

// The one source of randomness of the generator: sfc32, seeded from the SHA-256 of the seed and the stream name, so a
// stream gives the same draws on any machine, and each planned unit draws from its own stream, named by its plan key.
export const createStream = (seed: number, name: string): IRandomStream => {
  const digest = createHash('sha256')
    .update(`${String(seed)}\u0000${name}`)
    .digest()
  let [first, second, third, fourth] = [0, 4, 8, 12].map((offset) => digest.readUInt32LE(offset)) as [
    number,
    number,
    number,
    number,
  ]
  const nextUint32 = (): number => {
    const sum = (((first + second) >>> 0) + fourth) >>> 0
    fourth = (fourth + 1) >>> 0
    first = second ^ (second >>> 9)
    second = (third + (third << 3)) >>> 0
    third = ((third << 21) | (third >>> 11)) >>> 0
    third = (third + sum) >>> 0
    return sum
  }
  for (let round = 0; round < WARM_UP_ROUNDS; round += 1) {
    nextUint32()
  }

  const next = (): number => nextUint32() / UINT32
  const integer = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1))
  const pick = <TItem>(items: readonly TItem[]): TItem => {
    const item = items[integer(0, items.length - 1)]
    if (item === undefined) {
      throw new Error('Cannot pick from an empty list')
    }
    return item
  }
  return {
    next,
    integer,
    pick,
    weightedPick: <TItem>(entries: readonly (readonly [TItem, number])[]): TItem => {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
      let remaining = next() * total
      for (const [item, weight] of entries) {
        remaining -= weight
        if (remaining < 0) {
          return item
        }
      }
      const last = entries.at(-1)
      if (last === undefined) {
        throw new Error('Cannot pick from an empty list')
      }
      return last[0]
    },
    shuffle: <TItem>(items: readonly TItem[]): TItem[] => {
      const shuffled = [...items]
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const other = integer(0, index)
        const held = shuffled[index] as TItem
        shuffled[index] = shuffled[other] as TItem
        shuffled[other] = held
      }
      return shuffled
    },
  }
}
