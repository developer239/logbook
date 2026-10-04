import { describe, expect, it } from 'vitest'
import { clipChars } from './clip-chars.js'

describe('clipChars', () => {
  it('returns text of max characters or fewer unchanged and cuts longer text with an ellipsis', () => {
    // Arrange
    const max = 5

    // Act
    const results = [clipChars('short', max), clipChars('abc', max), clipChars('longer text', max)]

    // Assert
    expect(results).toStrictEqual(['short', 'abc', 'longe…'])
  })

  it('never splits an emoji into a lone surrogate', () => {
    // Arrange
    const text = 'a😀b'

    // Act
    const clipped = clipChars(text, 2)

    // Assert
    expect(clipped).toBe('a😀…')
  })
})
