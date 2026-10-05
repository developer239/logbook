import { KNOWN_TOOLS, type ToolFamily } from '@log-book/adapter-api'

// OpenCode's tools by lowercased name, in their 1.x and 2.0 spellings.
const OPENCODE_FAMILIES: ReadonlyMap<string, ToolFamily> = new Map<string, ToolFamily>([
  ['bash', 'shell'],
  ['shell', 'shell'],
  ['read', 'read'],
  ['edit', 'edit'],
  ['write', 'edit'],
  ['patch', 'edit'],
  ['apply_patch', 'edit'],
  ['grep', 'search'],
  ['glob', 'search'],
  ['list', 'search'],
  ['task', 'subagent'],
  ['subagent', 'subagent'],
  ['webfetch', 'web'],
  ['websearch', 'web'],
  ['todowrite', 'todo'],
  ['todoread', 'todo'],
  ['skill', 'skill'],
  ['question', 'question'],
])

export interface IToolName {
  server: string | null
  bareName: string
  family: ToolFamily
}

// OpenCode records no MCP server for a tool, and the adapter never guesses one from its configuration, which may have
// changed since the call. The family is OpenCode's table on the lowercased name, then KNOWN_TOOLS on it, else `other`:
// a Code Mode `execute` call and a plugin tool stay `other`.
export const toolNameOf = (name: string): IToolName => {
  const lowered = name.toLowerCase()
  return {
    server: null,
    bareName: name,
    family: OPENCODE_FAMILIES.get(lowered) ?? KNOWN_TOOLS.get(lowered) ?? 'other',
  }
}
