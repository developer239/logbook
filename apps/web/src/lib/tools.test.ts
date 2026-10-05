import { describe, expect, it } from 'vitest'
import type { IOfferedTool } from './queries/tools'
import {
  cookbookTool,
  isCookbookFamily,
  isPluginFamily,
  isSkillBody,
  parseMcpName,
  skillNameOf,
  normalName,
  toolName,
} from './tools'

const offered = new Map<string, IOfferedTool>([['oc_run', { module: 'oc', name: 'oc_run', definitionChars: 100 }]])

describe('parseMcpName', () => {
  it('should split an MCP tool name into its server and tool', () => {
    expect(parseMcpName('mcp__opencode__oc_run')).toEqual({ server: 'opencode', tool: 'oc_run' })
    expect(parseMcpName('mcp__claude_ai_Docs__batch__x')).toEqual({ server: 'claude_ai_Docs', tool: 'batch__x' })
  })

  it('should read a tool of the harness itself as no MCP tool', () => {
    expect(parseMcpName('Bash')).toBeNull()
    expect(parseMcpName('mcp__only')).toBeNull()
  })
})

describe('cookbookTool', () => {
  it('should find a cookbook tool by its name through the cookbook server only', () => {
    expect(cookbookTool(offered, 'claude-code', 'mcp__opencode__oc_run')?.module).toBe('oc')
    expect(cookbookTool(offered, 'claude-code', 'mcp__claude_ai_Docs__oc_run')).toBeUndefined()
    expect(cookbookTool(offered, 'claude-code', 'oc_run')).toBeUndefined()
    expect(cookbookTool(offered, 'opencode', 'OC_RUN')?.module).toBe('oc')
  })
})

describe('families', () => {
  it('should file the cookbook under cookbook: and dispatch, other servers under mcp:', () => {
    expect([isCookbookFamily('cookbook:oc'), isCookbookFamily('dispatch'), isCookbookFamily('mcp:docs')]).toEqual([
      true,
      true,
      false,
    ])
    expect([isPluginFamily('cookbook:oc'), isPluginFamily('dispatch'), isPluginFamily('mcp:docs')]).toEqual([
      true,
      true,
      true,
    ])
    expect(isPluginFamily('shell')).toBe(false)
  })
})

describe('skills', () => {
  it('should read the skill a message loads from the last part of its directory', () => {
    const text = 'Base directory for this skill: /Users/me/.claude/skills/language-typescript\n\n# TypeScript'

    expect(isSkillBody(text)).toBe(true)
    expect(skillNameOf(text)).toBe('language-typescript')
    expect(isSkillBody('hello')).toBe(false)
  })
})

describe('toolName', () => {
  it('should drop an MCP server from a tool name, and only that', () => {
    expect(toolName('mcp__opencode__oc_run')).toBe('oc_run')
    expect(toolName('mcp__claude_ai_Docs__batch')).toBe('batch')
    expect(toolName('Bash')).toBe('Bash')
  })

  it('should agree on a tool name across harnesses', () => {
    expect([normalName('Bash'), normalName('bash'), normalName('mcp__opencode__Oc_Run')]).toEqual([
      'bash',
      'bash',
      'oc_run',
    ])
  })
})
