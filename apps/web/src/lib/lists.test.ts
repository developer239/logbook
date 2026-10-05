import { describe, expect, it } from 'vitest'
import { countBy, partition, sum, sumBy } from './lists'

describe('lists', () => {
  it('should add up numbers and what a function reads from items, and nothing as zero', () => {
    expect(sum([1, 2, 3.5])).toBe(6.5)
    expect(sumBy([{ value: 2 }, { value: 5 }], (item) => item.value)).toBe(7)
    expect(sum([])).toBe(0)
  })

  it('should count items by key in the order the keys first appear', () => {
    const counts = countBy(['b', 'a', 'b', 'c', 'b'], (item) => item)

    expect([...counts]).toEqual([
      ['b', 3],
      ['a', 1],
      ['c', 1],
    ])
  })

  it('should split items into those that are and those that are not, keeping their order', () => {
    expect(partition([1, 2, 3, 4, 5], (item) => item % 2 === 1)).toEqual([
      [1, 3, 5],
      [2, 4],
    ])
  })
})
