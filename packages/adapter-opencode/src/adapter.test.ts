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
      locationVariables: [
        { name: 'OPENCODE_DB', changes: "OpenCode's database file; a relative path is inside its data directory" },
        {
          name: 'OPENCODE_DISABLE_CHANNEL_DB',
          changes: '1 or true reads opencode.db, instead of the newest opencode-<channel>.db',
        },
        { name: 'XDG_DATA_HOME', changes: "OpenCode's data directory (opencode inside it)" },
      ],
    })
  })
})
