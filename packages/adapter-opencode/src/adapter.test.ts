import { describe, expect, it } from 'vitest'
import { openCode } from './adapter.js'

describe('openCode', () => {
  it('describes OpenCode', () => {
    // Arrange
    const adapter = openCode()

    // Act
    const { descriptor } = adapter

    // Assert
    expect(descriptor).toStrictEqual({
      id: 'opencode',
      name: 'OpenCode',
      defaultAgent: 'OpenCode',
      unitNoun: 'sessions',
      filterAlias: 'opencode',
      parserVersion: 1,
      testedVersions: ['2.0'],
      locationVariables: ['OPENCODE_DB', 'OPENCODE_DISABLE_CHANNEL_DB', 'XDG_DATA_HOME'],
    })
  })
})
