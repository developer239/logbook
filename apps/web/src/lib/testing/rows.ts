import type { DatabaseSync } from 'node:sqlite'
import { parseRange, type IRange } from '../range'
import { DAY, MINUTE, SECOND } from '../time'
import { insert } from './warehouse'

// A small, invented set of conversations that exercises every query: one
// conversation I typed (with a correction, a compaction, a retry loop and
// failures of every kind), the agent it started, and a scripted run.

export const START = Date.UTC(2026, 8, 14, 10)

const NOW = START + 2 * DAY

export const everything = (): IRange => parseRange(new URLSearchParams('range=all'), NOW)

interface ILabel {
  recordType: 'session' | 'tool_call' | 'message' | 'reaction' | 'rule'
  recordId: string
  labeller: string
  name: string
  value: string
  at?: number
  version?: number
}

const label = (db: DatabaseSync, row: ILabel): void => {
  insert(db, 'label', {
    record_type: row.recordType,
    record_id: row.recordId,
    labeller: row.labeller,
    version: row.version ?? 1,
    name: row.name,
    value: row.value,
    labelled_at: row.at ?? START + 60 * MINUTE,
  })
}

interface ISessionRow {
  id: string
  harness: string
  origin: string
  title: string | null
  agent?: string
  projectDir?: string
  startedAt: number
  endedAt: number
}

const session = (db: DatabaseSync, row: ISessionRow): void => {
  insert(db, 'session', {
    id: row.id,
    harness: row.harness,
    source_id: `source-${row.id}`,
    origin: row.origin,
    title: row.title,
    agent: row.agent ?? null,
    project_dir: row.projectDir ?? null,
    started_at: row.startedAt,
    ended_at: row.endedAt,
  })
}

interface IMessageRow {
  id: string
  sessionId: string
  seq: number
  actor: 'user' | 'assistant' | 'harness'
  at: number
  text: string
  completedAt?: number
  model?: string
  branch?: string
  // Input, cache read and cache write tokens of the request, and its output.
  tokens?: [number, number, number, number]
}

const message = (db: DatabaseSync, row: IMessageRow): void => {
  insert(db, 'message', {
    id: row.id,
    session_id: row.sessionId,
    seq: row.seq,
    actor: row.actor,
    source_role: row.actor,
    created_at: row.at,
    completed_at: row.completedAt ?? null,
    model: row.model ?? null,
    git_branch: row.branch ?? null,
    tokens_input: row.tokens?.[0] ?? null,
    tokens_cache_read: row.tokens?.[1] ?? null,
    tokens_cache_write: row.tokens?.[2] ?? null,
    tokens_output: row.tokens?.[3] ?? null,
  })
  part(db, row.id, row.sessionId, 0, 'text', row.text)
}

const part = (
  db: DatabaseSync,
  messageId: string,
  sessionId: string,
  idx: number,
  kind: string,
  text: string,
  toolCallId?: string
): void => {
  insert(db, 'part', {
    message_id: messageId,
    session_id: sessionId,
    idx,
    kind,
    text,
    tool_call_id: toolCallId ?? null,
  })
}

interface ITurnRow {
  sessionId: string
  messageId: string
  seq: number
  startedAt: number
  endedAt: number
  modelMs: number
  toolMs?: number
  idleMs?: number
  humanWaitMs?: number
  requests?: number
  parentTurnId?: string
  parentToolCallId?: string
}

const turn = (db: DatabaseSync, row: ITurnRow): void => {
  insert(db, 'turn', {
    session_id: row.sessionId,
    message_id: row.messageId,
    seq: row.seq,
    is_prompt: 1,
    requests: row.requests ?? 1,
    tool_calls: 0,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    model_ms: row.modelMs,
    tool_ms: row.toolMs ?? 0,
    idle_ms: row.idleMs ?? 0,
    human_wait_ms: row.humanWaitMs ?? 0,
    parent_turn_id: row.parentTurnId ?? null,
    parent_tool_call_id: row.parentToolCallId ?? null,
  })
}

interface IToolCallRow {
  id: string
  sessionId: string
  messageId: string
  name: string
  family: string
  status?: 'completed' | 'error'
  input?: string
  // Null leaves the call untimed, as some sources do.
  startedAt: number | null
  durationMs?: number
  childSessionId?: string
  result?: string
}

const toolCall = (db: DatabaseSync, row: IToolCallRow): void => {
  insert(db, 'tool_call', {
    id: row.id,
    session_id: row.sessionId,
    message_id: row.messageId,
    name: row.name,
    family: row.family,
    input_json: row.input ?? '{}',
    status: row.status ?? 'completed',
    child_session_id: row.childSessionId ?? null,
    started_at: row.startedAt,
    ended_at: row.startedAt === null ? null : row.startedAt + (row.durationMs ?? SECOND),
  })
  if (row.result !== undefined) {
    part(db, row.messageId, row.sessionId, 5, 'tool_result', row.result, row.id)
  }
}

const SHELL_TEST = 'check a change (format, lint, typecheck, build)'

export const seedRows = (db: DatabaseSync): void => {
  session(db, {
    id: 'ses-me',
    harness: 'claude-code',
    origin: 'interactive',
    title: 'Fix the widget',
    projectDir: '/work/widgets',
    startedAt: START,
    endedAt: START + 30 * MINUTE,
  })
  session(db, {
    id: 'ses-agent',
    harness: 'claude-code',
    origin: 'subagent',
    title: '',
    agent: 'reviewer',
    startedAt: START + 5 * MINUTE,
    endedAt: START + 10 * MINUTE,
  })
  session(db, {
    id: 'ses-script',
    harness: 'opencode',
    origin: 'headless',
    title: null,
    projectDir: '/work/other',
    startedAt: START + DAY,
    endedAt: START + DAY + 2 * MINUTE,
  })

  message(db, { id: 'm-me-1', sessionId: 'ses-me', seq: 1, actor: 'user', at: START, text: 'Fix the widget please' })
  message(db, {
    id: 'm-me-2',
    sessionId: 'ses-me',
    seq: 2,
    actor: 'assistant',
    at: START + MINUTE,
    completedAt: START + 2 * MINUTE,
    model: 'model-a',
    branch: 'feature/widget',
    tokens: [1000, 4000, 500, 200],
    text: 'On it',
  })
  message(db, {
    id: 'm-me-3',
    sessionId: 'ses-me',
    seq: 3,
    actor: 'assistant',
    at: START + 3 * MINUTE,
    completedAt: START + 4 * MINUTE,
    model: 'model-a',
    tokens: [100, 6000, 0, 300],
    text: 'Done',
  })
  message(db, {
    id: 'm-me-4',
    sessionId: 'ses-me',
    seq: 4,
    actor: 'user',
    at: START + 10 * MINUTE,
    text: 'No, use the other widget',
  })
  part(db, 'm-me-4', 'ses-me', 1, 'compaction', 'Summary of the earlier work')
  message(db, {
    id: 'm-me-5',
    sessionId: 'ses-me',
    seq: 5,
    actor: 'assistant',
    at: START + 11 * MINUTE,
    completedAt: START + 12 * MINUTE,
    model: 'model-b',
    tokens: [100, 7000, 0, 150],
    text: 'Fixed',
  })

  message(db, {
    id: 'm-ag-1',
    sessionId: 'ses-agent',
    seq: 1,
    actor: 'user',
    at: START + 5 * MINUTE,
    text: 'Review the widget',
  })
  message(db, {
    id: 'm-ag-2',
    sessionId: 'ses-agent',
    seq: 2,
    actor: 'assistant',
    at: START + 6 * MINUTE,
    completedAt: START + 8 * MINUTE,
    model: 'model-a',
    tokens: [50, 1000, 0, 80],
    text: 'Looks fine',
  })
  message(db, {
    id: 'm-ag-3',
    sessionId: 'ses-agent',
    seq: 3,
    actor: 'harness',
    at: START + 8 * MINUTE,
    text: 'Base directory for this skill: /skills/writing\nWrite plainly.',
  })

  message(db, {
    id: 'm-sc-1',
    sessionId: 'ses-script',
    seq: 1,
    actor: 'user',
    at: START + DAY,
    text: '<command-name>/ship</command-name>',
  })
  message(db, {
    id: 'm-sc-2',
    sessionId: 'ses-script',
    seq: 2,
    actor: 'user',
    at: START + DAY + MINUTE,
    text: '  [Request interrupted by user]',
  })
  message(db, {
    id: 'm-sc-3',
    sessionId: 'ses-script',
    seq: 3,
    actor: 'user',
    at: START + DAY + 2 * MINUTE,
    text: '[note] release v2 please',
  })

  turn(db, {
    sessionId: 'ses-me',
    messageId: 'm-me-1',
    seq: 0,
    startedAt: START,
    endedAt: START + 4 * MINUTE,
    modelMs: 2 * MINUTE,
    toolMs: MINUTE,
    requests: 2,
  })
  turn(db, {
    sessionId: 'ses-me',
    messageId: 'm-me-4',
    seq: 1,
    startedAt: START + 10 * MINUTE,
    endedAt: START + 12 * MINUTE,
    modelMs: MINUTE,
    idleMs: 30 * SECOND,
    humanWaitMs: 10 * SECOND,
  })
  turn(db, {
    sessionId: 'ses-agent',
    messageId: 'm-ag-1',
    seq: 0,
    startedAt: START + 5 * MINUTE,
    endedAt: START + 9 * MINUTE,
    modelMs: MINUTE,
    parentTurnId: 'm-me-1',
    parentToolCallId: 'c-spawn',
  })
  turn(db, {
    sessionId: 'ses-script',
    messageId: 'm-sc-1',
    seq: 0,
    startedAt: START + DAY,
    endedAt: START + DAY + 2 * MINUTE,
    modelMs: 30 * SECOND,
    requests: 0,
  })

  const edit = '{"file_path":"/work/widgets/a.ts","old_string":"x"}'
  toolCall(db, {
    id: 'c-read',
    sessionId: 'ses-me',
    messageId: 'm-me-2',
    name: 'Read',
    family: 'file',
    input: '{"file_path":"/work/widgets/a.ts"}',
    startedAt: START + MINUTE + 10 * SECOND,
  })
  toolCall(db, {
    id: 'c-bash-fail',
    sessionId: 'ses-me',
    messageId: 'm-me-2',
    name: 'Bash',
    family: 'shell',
    status: 'error',
    input: '{"command":"npm test"}',
    startedAt: START + MINUTE + 30 * SECOND,
    durationMs: 10 * SECOND,
  })
  // Claude Code loads a plugin tool's definition through ToolSearch, whose
  // result names the tool; an untimed call has its message's time.
  toolCall(db, {
    id: 'c-search',
    sessionId: 'ses-me',
    messageId: 'm-me-2',
    name: 'ToolSearch',
    family: 'builtin',
    startedAt: null,
    result: '(tool reference: mcp__opencode__notes_add)',
  })
  toolCall(db, {
    id: 'c-edit-1',
    sessionId: 'ses-me',
    messageId: 'm-me-3',
    name: 'Edit',
    family: 'file',
    status: 'error',
    input: edit,
    startedAt: START + 3 * MINUTE + SECOND,
  })
  toolCall(db, {
    id: 'c-edit-2',
    sessionId: 'ses-me',
    messageId: 'm-me-3',
    name: 'Edit',
    family: 'file',
    status: 'error',
    input: edit,
    startedAt: START + 3 * MINUTE + 3 * SECOND,
  })
  toolCall(db, {
    id: 'c-edit-3',
    sessionId: 'ses-me',
    messageId: 'm-me-3',
    name: 'Edit',
    family: 'file',
    status: 'error',
    input: edit,
    startedAt: START + 3 * MINUTE + 5 * SECOND,
  })
  toolCall(db, {
    id: 'c-spawn',
    sessionId: 'ses-me',
    messageId: 'm-me-3',
    name: 'Task',
    family: 'subagent',
    childSessionId: 'ses-agent',
    startedAt: START + 3 * MINUTE + 20 * SECOND,
    durationMs: 30 * SECOND,
  })
  toolCall(db, {
    id: 'c-test-fail',
    sessionId: 'ses-me',
    messageId: 'm-me-5',
    name: 'Bash',
    family: 'shell',
    status: 'error',
    input: '{"command":"npm run test"}',
    startedAt: START + 11 * MINUTE + 10 * SECOND,
    durationMs: 10 * SECOND,
  })
  toolCall(db, {
    id: 'c-notes',
    sessionId: 'ses-me',
    messageId: 'm-me-5',
    name: 'mcp__opencode__notes_add',
    family: 'cookbook:notes',
    input: '{"text":"hi"}',
    startedAt: START + 11 * MINUTE + 30 * SECOND,
    result: 'saved',
  })

  insert(db, 'event', {
    id: 'ev-1',
    session_id: 'ses-me',
    kind: 'tools-loaded',
    at: START + 2 * MINUTE,
    data_json: '{"tools":[{"name":"mcp__opencode__notes_add","chars":400}]}',
  })
  insert(db, 'tool', {
    module: 'notes',
    name: 'notes_add',
    description: 'Add a note',
    input_schema: '{"type":"object"}',
    is_in_claude_code: 1,
  })
  insert(db, 'tool', {
    module: 'notes',
    name: 'notes_list',
    description: 'List the notes',
    input_schema: '{"type":"object"}',
    is_in_claude_code: 1,
  })

  // An older label of the same name loses to the newer one.
  label(db, {
    recordType: 'session',
    recordId: 'ses-me',
    labeller: 'haiku',
    name: 'goal',
    value: 'build a feature',
    at: START,
  })
  label(db, {
    recordType: 'session',
    recordId: 'ses-me',
    labeller: 'haiku',
    name: 'goal',
    value: 'fix a bug',
    version: 2,
  })
  label(db, { recordType: 'session', recordId: 'ses-me', labeller: 'haiku', name: 'outcome', value: 'failed' })
  label(db, {
    recordType: 'session',
    recordId: 'ses-me',
    labeller: 'haiku',
    name: 'outcomeNote',
    value: 'tests still red',
  })
  label(db, { recordType: 'session', recordId: 'ses-agent', labeller: 'haiku', name: 'goal', value: 'review' })
  label(db, { recordType: 'session', recordId: 'ses-agent', labeller: 'haiku', name: 'outcome', value: 'done' })
  label(db, {
    recordType: 'session',
    recordId: 'ses-script',
    labeller: 'haiku',
    name: 'goal',
    value: 'build a feature',
  })
  label(db, { recordType: 'session', recordId: 'ses-script', labeller: 'haiku', name: 'outcome', value: 'done' })

  // A shell failure is read from the model's label, never the rules'.
  label(db, {
    recordType: 'tool_call',
    recordId: 'c-bash-fail',
    labeller: 'haiku',
    name: 'failure',
    value: 'command mistake',
  })
  label(db, {
    recordType: 'tool_call',
    recordId: 'c-bash-fail',
    labeller: 'rules',
    name: 'failure',
    value: 'real result',
  })
  label(db, { recordType: 'tool_call', recordId: 'c-bash-fail', labeller: 'haiku', name: 'purpose', value: SHELL_TEST })
  label(db, {
    recordType: 'tool_call',
    recordId: 'c-test-fail',
    labeller: 'haiku',
    name: 'failure',
    value: 'real result',
  })
  // Another call's cause is the rules' answer where they gave one.
  label(db, { recordType: 'tool_call', recordId: 'c-edit-1', labeller: 'rules', name: 'cause', value: 'edit mismatch' })
  label(db, { recordType: 'tool_call', recordId: 'c-edit-1', labeller: 'haiku', name: 'cause', value: 'other' })
  label(db, { recordType: 'tool_call', recordId: 'c-edit-2', labeller: 'haiku', name: 'cause', value: 'invalid call' })

  // The newest labelling of a prompt is the one that counts: an older model saw praise in it, a newer one a
  // correction and teaching.
  label(db, { recordType: 'message', recordId: 'm-me-4', labeller: 'haiku', name: 'act', value: 'task', at: START })
  label(db, {
    recordType: 'reaction',
    recordId: 'm-me-4#1',
    labeller: 'haiku',
    name: 'reaction',
    value: 'praise',
    at: START,
  })
  label(db, { recordType: 'message', recordId: 'm-me-4', labeller: 'sonnet', name: 'act', value: 'task' })
  label(db, { recordType: 'reaction', recordId: 'm-me-4#1', labeller: 'sonnet', name: 'reaction', value: 'teaching' })
  label(db, { recordType: 'reaction', recordId: 'm-me-4#2', labeller: 'sonnet', name: 'reaction', value: 'correction' })
  label(db, {
    recordType: 'reaction',
    recordId: 'm-me-4#2',
    labeller: 'sonnet',
    name: 'quote',
    value: 'use the other widget',
  })
  label(db, { recordType: 'reaction', recordId: 'm-me-4#3', labeller: 'sonnet', name: 'reaction', value: 'praise' })
  label(db, { recordType: 'reaction', recordId: 'm-me-4#3', labeller: 'sonnet', name: 'target', value: 'design' })
  label(db, { recordType: 'reaction', recordId: 'm-me-4#3', labeller: 'sonnet', name: 'quote', value: 'nice layout' })

  // The human judged the correction right, and the teaching wrong when an older labelling numbered it.
  label(db, { recordType: 'reaction', recordId: 'm-me-4#2', labeller: 'human', name: 'verdict', value: 'right' })
  label(db, { recordType: 'reaction', recordId: 'm-me-4#2', labeller: 'human', name: 'verdictOn', value: 'sonnet v1' })
  label(db, { recordType: 'reaction', recordId: 'm-me-4#1', labeller: 'human', name: 'verdict', value: 'wrong' })
  label(db, { recordType: 'reaction', recordId: 'm-me-4#1', labeller: 'human', name: 'verdictOn', value: 'haiku v1' })

  // The first prompt has no reaction. The replies' codes: a newer labelling overrules an older one.
  label(db, { recordType: 'message', recordId: 'm-me-1', labeller: 'sonnet', name: 'act', value: 'task' })
  label(db, {
    recordType: 'message',
    recordId: 'm-me-3',
    labeller: 'haiku',
    name: 'reply',
    value: 'permission',
    at: START,
  })
  label(db, {
    recordType: 'message',
    recordId: 'm-me-3',
    labeller: 'sonnet',
    name: 'reply',
    value: 'unverified,pushback',
  })
  label(db, { recordType: 'message', recordId: 'm-ag-2', labeller: 'sonnet', name: 'reply', value: 'permission' })
  label(db, { recordType: 'message', recordId: 'm-me-5', labeller: 'sonnet', name: 'reply', value: 'none' })

  // The cookbook grouped the correction's rule with others and found no instruction that says it.
  label(db, { recordType: 'reaction', recordId: 'm-me-4#2', labeller: 'sonnet', name: 'ruleGroup', value: 'rule:1' })
  label(db, {
    recordType: 'rule',
    recordId: 'rule:1',
    labeller: 'sonnet',
    name: 'text',
    value: 'Use the widget the user names.',
  })
  label(db, { recordType: 'rule', recordId: 'rule:1', labeller: 'sonnet', name: 'coverage', value: 'missing' })
  label(db, {
    recordType: 'rule',
    recordId: 'rule:2',
    labeller: 'sonnet',
    name: 'text',
    value: 'A rule said only before the range.',
  })
}
