// Names of the owner's own tooling, which no tracked file but this one may hold, in any letter case: Log Book knows
// nothing of that tooling.
export const OWNER_LITERALS: readonly string[] = [
  'cookbook',
  'oc_run',
  'orch_',
  'mcp__opencode__',
  'chirp-',
  'ask-angel-',
  '/tmp/orchestration',
  'COOKBOOK_',
]

// The known-tool table, the one other file that may hold owner literals, and only as these tool names.
export const KNOWN_TOOLS_FILE = 'packages/adapter-api/src/known-tools.ts'
export const KNOWN_TOOL_NAMES: readonly string[] = ['oc_run', 'orch_dispatch', 'oc_wait_runs', 'orch_wait']
