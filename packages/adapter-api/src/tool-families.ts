// The coarse family every tool call gets, so readers group calls without a harness branch. Beside these thirteen
// fixed families, a tool from MCP server <server> belongs to `mcp:<server>` (mcpFamily).
export const TOOL_FAMILIES = [
  // Run a command.
  'shell',
  // Read a file.
  'read',
  // Write, edit or patch a file.
  'edit',
  // Find files or text.
  'search',
  // Start another agent session through the harness's own subagent mechanism.
  'subagent',
  // Start another agent as its own session, outside the harness's own subagent mechanism; only through KNOWN_TOOLS.
  'dispatch',
  // Fetch or search the web.
  'web',
  // Keep a task list.
  'todo',
  // Load a skill.
  'skill',
  // Load tool definitions on demand.
  'tool-search',
  // Ask the human and wait for the answer.
  'question',
  // Wait for something running elsewhere (a background task's output, a monitored condition).
  'wait',
  // Anything else, including a tool called by a name the harness does not have.
  'other',
] as const

const MCP_FAMILY_PREFIX = 'mcp:'

export type ToolFamily = (typeof TOOL_FAMILIES)[number] | `${typeof MCP_FAMILY_PREFIX}${string}`

export const mcpFamily = (server: string): ToolFamily => `${MCP_FAMILY_PREFIX}${server}`

export const isToolFamily = (value: string): value is ToolFamily =>
  TOOL_FAMILIES.some((family) => family === value) ||
  (value.startsWith(MCP_FAMILY_PREFIX) && value.length > MCP_FAMILY_PREFIX.length)
