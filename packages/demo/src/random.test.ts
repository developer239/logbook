import { describe, expect, it } from 'vitest'
import { createStream, type IRandomStream } from './random.js'

const DRAW_COUNT = 1000

const drawMany = (stream: IRandomStream): number[] => Array.from({ length: DRAW_COUNT }, () => stream.next())

describe('createStream', () => {
  it('gives the same first 1,000 draws for the same seed and name', () => {
    // Arrange
    const first = createStream(7, 'unit:0001')
    const second = createStream(7, 'unit:0001')

    // Act
    const draws = [drawMany(first), drawMany(second)]

    // Assert
    expect(draws[0]).toStrictEqual(draws[1])
  })

  it.each([
    ['name', 7, 'unit:0002'],
    ['seed', 8, 'unit:0001'],
  ])('gives different draws for a different %s', (_changed, seed, name) => {
    // Arrange
    const reference = createStream(7, 'unit:0001')
    const other = createStream(seed, name)

    // Act
    const draws = [drawMany(reference), drawMany(other)]

    // Assert
    expect(draws[0]).not.toStrictEqual(draws[1])
  })

  it('draws the recorded values for seed 1 and a fixed name', () => {
    // Arrange
    const stream = createStream(1, 'fixed')

    // Act
    const draws = Array.from({ length: 5 }, () => stream.next())

    // Assert
    expect(draws).toStrictEqual([
      0.48835938586853445, 0.33902990189380944, 0.011779998196288943, 0.34559623757377267, 0.28622248116880655,
    ])
  })

  it('draws the recorded integer, pick, weighted pick and shuffle for seed 1 and a fixed name', () => {
    // Arrange
    const stream = createStream(1, 'fixed')

    // Act
    const draws = [
      stream.integer(1, 6),
      stream.integer(1, 6),
      stream.pick(['a', 'b', 'c']),
      stream.weightedPick([
        ['x', 1],
        ['y', 3],
      ]),
      stream.shuffle([1, 2, 3, 4, 5]),
    ]

    // Assert
    expect(draws).toStrictEqual([3, 3, 'a', 'y', [3, 5, 1, 4, 2]])
  })

  it('consumes one value per integer, pick and weighted pick, and one fewer than the length per shuffle', () => {
    // Arrange
    const stream = createStream(3, 'consumption')
    const twin = createStream(3, 'consumption')

    // Act
    stream.integer(0, 1_000_000)
    stream.pick(['only'])
    stream.weightedPick([['only', 1]])
    stream.shuffle(['a', 'b', 'c', 'd'])
    for (let draw = 0; draw < 6; draw += 1) {
      twin.next()
    }

    // Assert
    expect(stream.next()).toBe(twin.next())
  })

  it('keeps integers within both bounds', () => {
    // Arrange
    const stream = createStream(5, 'bounds')

    // Act
    const values = new Set(Array.from({ length: DRAW_COUNT }, () => stream.integer(-2, 2)))

    // Assert
    expect([...values].toSorted((left, right) => left - right)).toStrictEqual([-2, -1, 0, 1, 2])
  })

  it('never picks an entry of zero weight and leaves the shuffled list as it was', () => {
    // Arrange
    const stream = createStream(5, 'weights')
    const items = ['a', 'b', 'c']

    // Act
    const picks = new Set(
      Array.from({ length: DRAW_COUNT }, () =>
        stream.weightedPick([
          ['never', 0],
          ['always', 2],
        ])
      )
    )
    const shuffled = stream.shuffle(items)

    // Assert
    expect({ picks: [...picks], items, sorted: shuffled.toSorted() }).toStrictEqual({
      picks: ['always'],
      items: ['a', 'b', 'c'],
      sorted: ['a', 'b', 'c'],
    })
  })

  it.each([
    ['pick', (stream: IRandomStream): unknown => stream.pick([])],
    ['weighted pick', (stream: IRandomStream): unknown => stream.weightedPick([])],
  ])('throws on a %s from an empty list', (_draw, draw) => {
    // Arrange
    const stream = createStream(1, 'empty')

    // Act
    const act = (): unknown => draw(stream)

    // Assert
    expect(act).toThrow('Cannot pick from an empty list')
  })
})
