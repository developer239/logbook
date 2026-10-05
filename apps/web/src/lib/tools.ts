const MCP_NAME = /^mcp__(.+?)__(.+)$/u

export const parseMcpName = (full: string): { server: string; tool: string } | null => {
  const match = MCP_NAME.exec(full)
  return match?.[1] === undefined || match[2] === undefined ? null : { server: match[1], tool: match[2] }
}

export const toolName = (name: string): string => parseMcpName(name)?.tool ?? name

// The shell is Bash in one harness and bash in another.
export const normalName = (name: string): string => toolName(name).toLowerCase()

// The cookbook files its tools under cookbook:<first word of the name>, and
// its tools that start agents under dispatch.
export const isCookbookFamily = (family: string): boolean => family.startsWith('cookbook:') || family === 'dispatch'

export const isPluginFamily = (family: string): boolean => isCookbookFamily(family) || family.startsWith('mcp:')

export const SKILL_TOOL = 'skill'

// Claude Code injects a skill's text as a message that starts with this line,
// followed by the skill's directory.
export const SKILL_BODY = 'Base directory for this skill:'

export const isSkillBody = (text: string): boolean => text.startsWith(SKILL_BODY)

export const skillNameOf = (text: string): string =>
  text.slice(SKILL_BODY.length).split('\n')[0]?.trim().split('/').at(-1) ?? ''
