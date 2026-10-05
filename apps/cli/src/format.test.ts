import { describe, expect, it } from 'vitest'
import { formatCount, formatDuration, formatSize, tildePath } from './format.js'

describe('formatCount', () => {
  it.each([
    [0, '0'],
    [1010, '1,010'],
    [560_000, '560,000'],
  ])('writes %i as %s', (count, text) => {
    // Act
    const formatted = formatCount(count)

    // Assert
    expect(formatted).toBe(text)
  })
})

describe('formatSize', () => {
  it.each([
    [261_000_000, '261 MB'],
    [999_000_000, '999 MB'],
    [1_300_000_000, '1.3 GB'],
  ])('writes %i bytes as %s', (bytes, text) => {
    // Act
    const formatted = formatSize(bytes)

    // Assert
    expect(formatted).toBe(text)
  })
})

describe('formatDuration', () => {
  it.each([
    [1400, '1.4 s'],
    [31_000, '31 s'],
    [130_000, '2 min 10 s'],
    [1_080_000, '18 min'],
    [3_900_000, '1 h 5 min'],
    [7_500_000, '2 h 5 min'],
  ])('writes %i ms as %s', (milliseconds, text) => {
    // Act
    const formatted = formatDuration(milliseconds)

    // Assert
    expect(formatted).toBe(text)
  })
})

describe('tildePath', () => {
  it.each([
    ['/home/example/.local/share/log-book/warehouse.db', '~/.local/share/log-book/warehouse.db'],
    ['/home/example', '~'],
    ['/home/examples/file', '/home/examples/file'],
    ['/tmp/warehouse.db', '/tmp/warehouse.db'],
  ])('shows %s as %s', (path, text) => {
    // Act
    const shown = tildePath(path, '/home/example')

    // Assert
    expect(shown).toBe(text)
  })
})
