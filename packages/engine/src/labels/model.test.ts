import { describe, expect, it } from 'vitest'
import { DEFAULT_LABEL_MODEL, isLabelModelId } from './model.js'

describe('isLabelModelId', () => {
  it('accepts model ids and aliases and refuses anything else', () => {
    // Arrange
    const accepted = [DEFAULT_LABEL_MODEL, 'claude-sonnet-5-5', 'haiku']
    const refused = ['', 'claude haiku', '-x', 'claude-haiku-4-5[1m]', 'a'.repeat(129)]

    // Act
    const results = { accepted: accepted.map(isLabelModelId), refused: refused.map(isLabelModelId) }

    // Assert
    expect(results).toStrictEqual({ accepted: [true, true, true], refused: [false, false, false, false, false] })
  })
})
