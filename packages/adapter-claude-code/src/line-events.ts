import { blocksOf, stringOf, type ITranscriptLine } from './transcript-lines.js'

// Line kinds the importer leaves out on purpose, each for a stated reason.
export const IGNORED_KINDS: ReadonlySet<string> = new Set([
  // Context Claude Code assembles into the next request: the line records that it was attached, not the text the model
  // received, and its effect is in the next message's token counts.
  ...[
    'total_tokens_reminder',
    'environment',
    'edited_text_file',
    'command_permissions',
    'prompt_snapshot',
    'silent_turn_reminder',
    'mcp_instructions_delta',
    'skill_listing',
    'agent_listing_delta',
    'date',
    'session_context',
    'model',
    'instructions',
    'remote_session_change',
    'queued_command',
    'batching_reminder_sent',
    'file',
    'credential_org',
    'bash_output_audience_note',
    'hook_success',
    'task_reminder',
    'compact_file_reference',
    'thinking_drop',
    'read_truncation_notice',
    'hook_additional_context',
    'hook_system_message',
    'task_status',
    'plan_mode_exit',
    'auto_mode_exit',
    'auto_mode',
    'workflow_size_guideline_change',
    'ultra_effort_enter',
    'ultra_effort_exit',
    'date_change',
    'diagnostics',
  ].map((type) => `attachment:${type}`),
  // May re-attach skills after a compaction (unverified): ignored until a fixture shows its shape.
  'attachment:invoked_skills',
  // Claude Code's own turn timing: the engine measures turns itself, and two measures would disagree.
  'system:turn_duration',
  // Interface notices, not conversation.
  'system:informational',
  'system:scheduled_task_fire',
  'system:agents_killed',
  // Interface state.
  'last-prompt',
  'mode',
  'permission-mode',
  'atis-latch',
  // Backups of edited files for rewind.
  'file-history-snapshot',
  'file-history-delta',
  // Interface links and bookkeeping.
  'pr-link',
  'frame-link',
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
  // Session totals from a different counter than the per-message usage already imported.
  'cost-state',
  // A queued prompt: a delivered one is imported from its own user line, a removed one never reached the model.
  'queue-operation',
  // Meaning unverified: not mapped to the session's agent.
  'agent-name',
  // Continuation and fork links do not exist in this release.
  'continued-in',
  'fork-context-ref',
])

export const TITLE_KINDS: ReadonlySet<string> = new Set(['ai-title', 'custom-title'])

const SKILL_BASE = 'Base directory for this skill:'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// `system:<subtype>` for a system line, `attachment:<type>` for an attachment, the line's type otherwise.
export const lineKind = (line: ITranscriptLine): string => {
  if (line.type === 'system') {
    return `system:${String(line.subtype)}`
  }
  if (line.type === 'attachment') {
    return `attachment:${String(isRecord(line.attachment) ? line.attachment.type : undefined)}`
  }
  return String(line.type)
}

const names = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const namedEntries = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.name === 'string')
    : []

// A server list the announcement states, or null where it leaves it out.
const statedNames = (value: unknown): string[] | null => (Array.isArray(value) ? names(value) : null)

const failedServers = (value: unknown): { name: string; error: string }[] | null | undefined => {
  if (!Array.isArray(value)) {
    return null
  }
  const servers = value.map((entry: unknown) =>
    isRecord(entry) && typeof entry.name === 'string' && typeof entry.error === 'string'
      ? { name: entry.name, error: entry.error }
      : null
  )
  return servers.every((server) => server !== null) ? servers : undefined
}

// What one announcement of the offered tools changed; undefined when a failed server lacks its name or error.
export const toolsOffered = (attachment: unknown): Record<string, unknown> | undefined => {
  const delta = isRecord(attachment) ? attachment : {}
  const failed = failedServers(delta.failedMcpServers)
  if (failed === undefined) {
    return undefined
  }
  return {
    added: [...new Set([...names(delta.addedNames), ...names(delta.readdedNames)])],
    removed: [
      ...new Set([
        ...names(delta.removedNames),
        ...namedEntries(delta.retractedTools).map((entry) => String(entry.name)),
      ]),
    ],
    surfaced: names(delta.surfacedNames),
    pendingServers: statedNames(delta.pendingMcpServers),
    needsAuthServers: statedNames(delta.needsAuthMcpServers),
    failedServers: failed,
  }
}

// The size of each definition Claude Code added to the context: its name, description and input schema. Undefined
// when no entry is named, which says nothing was loaded.
export const toolsLoaded = (attachment: unknown): Record<string, unknown> | undefined => {
  const entries = namedEntries(isRecord(attachment) ? attachment.entries : undefined)
  if (entries.length === 0) {
    return undefined
  }
  return {
    tools: entries.map((entry) => ({
      name: entry.name,
      chars:
        String(entry.name).length +
        (stringOf(entry.description)?.length ?? 0) +
        JSON.stringify(entry.input_schema ?? {}).length,
    })),
  }
}

// A user line's whole text: its string content, or its text blocks joined with newlines.
const lineText = (line: ITranscriptLine): string =>
  stringOf(line.message?.content) ??
  blocksOf(line.message?.content)
    .flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .join('\n')

// The skill a meta line loads: the last path segment of its first line, and the length of its whole text.
export const skillLoaded = (line: ITranscriptLine): { name: string; chars: number } | null => {
  const text = lineText(line)
  if (line.isMeta !== true || !text.startsWith(SKILL_BASE)) {
    return null
  }
  const [firstLine = ''] = text.split('\n')
  const name = firstLine
    .slice(SKILL_BASE.length)
    .trim()
    .split('/')
    .filter((segment) => segment !== '')
    .at(-1)
  return name === undefined ? null : { name, chars: text.length }
}
