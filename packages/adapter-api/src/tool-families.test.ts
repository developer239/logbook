import { describe, expect, it } from 'vitest'
import { isToolFamily, mcpFamily, TOOL_FAMILIES } from './tool-families.js'

describe('isToolFamily', () => {
  it('accepts every fixed family and refuses an empty server, an unknown prefix and another case', () => {
    // Arrange
    const refused = ['mcp:', 'tracker:oc', 'Shell']

    // Act
    const results = { fixed: TOOL_FAMILIES.map((family) => isToolFamily(family)), refused: refused.map(isToolFamily) }

    // Assert
    expect(results).toStrictEqual({ fixed: TOOL_FAMILIES.map(() => true), refused: [false, false, false] })
  })
})

describe('mcpFamily', () => {
  it('names the family of an MCP server and passes isToolFamily', () => {
    // Arrange
    const server = 'tracker'

    // Act
    const family = mcpFamily(server)

    // Assert
    expect({ family, isFamily: isToolFamily(family) }).toStrictEqual({ family: 'mcp:tracker', isFamily: true })
  })
})
