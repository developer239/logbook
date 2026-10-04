import { describe, expect, it } from 'vitest'
import { KNOWN_TOOLS } from './known-tools.js'
import { TOOL_FAMILIES } from './tool-families.js'

describe('KNOWN_TOOLS', () => {
  it('keys lowercase names to fixed families', () => {
    // Arrange
    const entries = [...KNOWN_TOOLS]

    // Act
    const broken = entries.filter(
      ([name, family]) => name !== name.toLowerCase() || !TOOL_FAMILIES.some((fixed) => fixed === family)
    )

    // Assert
    expect({ count: entries.length, broken }).toStrictEqual({ count: 4, broken: [] })
  })
})
