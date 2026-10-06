import { describe, expect, it } from 'vitest'
import { basePathOf } from './site.js'

describe('basePathOf', () => {
  it.each([
    ['https://developer239.github.io/logbook/', '/logbook/'],
    ['https://example.com/', '/'],
  ])('serves %s under %s', (url, expected) => {
    // Act
    const base = basePathOf(url)

    // Assert
    expect(base).toBe(expected)
  })
})
