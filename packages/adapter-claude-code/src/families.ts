import { KNOWN_TOOLS, mcpFamily, type ToolFamily } from '@log-book/adapter-api'

// Claude Code's tools by lowercased name. A model may call a name Claude Code does not have, such as `bash`; it is
// classified by its lowercased name.
const CLAUDE_CODE_FAMILIES: ReadonlyMap<string, ToolFamily> = new Map<string, ToolFamily>([
  ['bash', 'shell'],
  ['read', 'read'],
  ['edit', 'edit'],
  ['write', 'edit'],
  ['multiedit', 'edit'],
  ['notebookedit', 'edit'],
  ['grep', 'search'],
  ['glob', 'search'],
  ['task', 'subagent'],
  ['agent', 'subagent'],
  ['webfetch', 'web'],
  ['websearch', 'web'],
  ['todowrite', 'todo'],
  ['taskcreate', 'todo'],
  ['taskupdate', 'todo'],
  ['skill', 'skill'],
  ['toolsearch', 'tool-search'],
  ['askuserquestion', 'question'],
  ['monitor', 'wait'],
  ['taskoutput', 'wait'],
])

// `mcp__<server>__<tool>`; the server group is non-greedy, so a server whose own name holds `__` splits at its first.
const MCP_NAME = /^mcp__(?<server>.+?)__(?<bareName>.+)$/u

export interface IToolName {
  server: string | null
  bareName: string
  family: ToolFamily
}

// The server and bare name split from the recorded name, and the family: Claude Code's table on the lowercased name,
// then KNOWN_TOOLS on the lowercased bare name (bare or behind a server of any name), then the server's own family,
// then `other`.
export const toolNameOf = (name: string): IToolName => {
  const groups = MCP_NAME.exec(name)?.groups
  const server = groups?.server ?? null
  const bareName = groups?.bareName ?? name
  const family =
    CLAUDE_CODE_FAMILIES.get(name.toLowerCase()) ??
    KNOWN_TOOLS.get(bareName.toLowerCase()) ??
    (server === null ? 'other' : mcpFamily(server))
  return { server, bareName, family }
}
