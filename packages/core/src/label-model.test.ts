import { describe, expect, it } from 'vitest'
import { isLabelModelId } from './label-model.js'

describe('isLabelModelId', () => {
  it('accepts model ids and aliases and refuses anything else', () => {
    // Arrange
    const accepted = ['claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5@20260101', 'haiku']
    const refused = ['', 'claude haiku', '-x', '--help', 'claude-haiku-4-5[1m]', 'a'.repeat(129)]

    // Act
    const results = { accepted: accepted.map(isLabelModelId), refused: refused.map(isLabelModelId) }

    // Assert
    expect(results).toStrictEqual({
      accepted: [true, true, true, true],
      refused: [false, false, false, false, false, false],
    })
  })
})
