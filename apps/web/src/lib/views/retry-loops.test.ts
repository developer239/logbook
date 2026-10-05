import { describe, expect, it } from 'vitest'
import { loopSummary } from './retry-loops'

describe('loopSummary', () => {
  it('should name the first tools and count the loops of the rest together', () => {
    const summary = loopSummary([
      { name: 'Bash', loops: 5 },
      { name: 'Read', loops: 4 },
      { name: 'Edit', loops: 3 },
      { name: 'Grep', loops: 2 },
      { name: 'Glob', loops: 1 },
    ])

    expect(summary.shown.map((entry) => entry.name)).toEqual(['Bash', 'Read', 'Edit'])
    expect(summary.others).toBe(3)
  })

  it('should have no others where the tools fit', () => {
    expect(loopSummary([{ name: 'Bash', loops: 2 }])).toEqual({ shown: [{ name: 'Bash', loops: 2 }], others: 0 })
    expect(loopSummary([])).toEqual({ shown: [], others: 0 })
  })
})
