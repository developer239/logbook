// One row type per table of the schema, with the columns as SQLite returns them (snake_case): INTEGER and REAL are
// number, TEXT is string, and a nullable column is also null. Beside each type is the list of its columns, which a
// compile-time check holds to every key of the type and nothing else, and a test holds to the table.

// Accepts a list only when it names every key of TRow; a missing key fails to compile with the key named.
const columnsOf =
  <TRow>() =>
  <const TList extends readonly (keyof TRow)[]>(
    list: TList &
      ([Exclude<keyof TRow, TList[number]>] extends [never] ? unknown : { missing: Exclude<keyof TRow, TList[number]> })
  ): TList =>
    list

export interface IHarnessRow {
  id: string
  name: string
  default_agent: string
  filter_alias: string
  is_found: number
  checked_at: number
  location: string | null
  location_variables: string
  version_seen: string | null
  notice: string | null
  problem: string | null
}

export const HARNESS_COLUMNS = columnsOf<IHarnessRow>()([
  'id',
  'name',
  'default_agent',
  'filter_alias',
  'is_found',
  'checked_at',
  'location',
  'location_variables',
  'version_seen',
  'notice',
  'problem',
])

export interface ISourceStateRow {
  harness: string
  locator: string
  fingerprint: string
  parser_version: number
  imported_at: number
}

export const SOURCE_STATE_COLUMNS = columnsOf<ISourceStateRow>()([
  'harness',
  'locator',
  'fingerprint',
  'parser_version',
  'imported_at',
])

export interface ISyncRunRow {
  id: number
  started_at: number
  ended_at: number | null
  outcome: string | null
  error: string | null
}

export const SYNC_RUN_COLUMNS = columnsOf<ISyncRunRow>()(['id', 'started_at', 'ended_at', 'outcome', 'error'])

export interface ISessionRow {
  id: string
  harness: string
  source_id: string
  origin: string
  is_scripted: number
  project_dir: string | null
  title: string | null
  agent: string | null
  spawned_by_session_id: string | null
  spawned_by_tool_call_id: string | null
  started_at: number | null
  ended_at: number | null
}

export const SESSION_COLUMNS = columnsOf<ISessionRow>()([
  'id',
  'harness',
  'source_id',
  'origin',
  'is_scripted',
  'project_dir',
  'title',
  'agent',
  'spawned_by_session_id',
  'spawned_by_tool_call_id',
  'started_at',
  'ended_at',
])

export interface IMessageRow {
  id: string
  session_id: string
  seq: number
  actor: string
  source_role: string
  created_at: number
  completed_at: number | null
  requested_at: number | null
  model: string | null
  agent: string | null
  git_branch: string | null
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
  reported_cost: number | null
}

export const MESSAGE_COLUMNS = columnsOf<IMessageRow>()([
  'id',
  'session_id',
  'seq',
  'actor',
  'source_role',
  'created_at',
  'completed_at',
  'requested_at',
  'model',
  'agent',
  'git_branch',
  'tokens_input',
  'tokens_output',
  'tokens_reasoning',
  'tokens_cache_read',
  'tokens_cache_write',
  'reported_cost',
])

export interface IPartRow {
  rowid: number
  message_id: string
  session_id: string
  idx: number
  kind: string
  text: string
  tool_call_id: string | null
}

export const PART_COLUMNS = columnsOf<IPartRow>()([
  'rowid',
  'message_id',
  'session_id',
  'idx',
  'kind',
  'text',
  'tool_call_id',
])

export interface IToolCallRow {
  id: string
  session_id: string
  message_id: string
  name: string
  bare_name: string
  server: string | null
  family: string
  input_json: string
  status: string
  child_session_id: string | null
  started_at: number | null
  ended_at: number | null
}

export const TOOL_CALL_COLUMNS = columnsOf<IToolCallRow>()([
  'id',
  'session_id',
  'message_id',
  'name',
  'bare_name',
  'server',
  'family',
  'input_json',
  'status',
  'child_session_id',
  'started_at',
  'ended_at',
])

export interface IEventRow {
  id: string
  session_id: string
  kind: string
  at: number
  data_json: string
}

export const EVENT_COLUMNS = columnsOf<IEventRow>()(['id', 'session_id', 'kind', 'at', 'data_json'])

export interface ILinkRow {
  parent_session_id: string
  parent_tool_call_id: string | null
  child_session_id: string
  kind: string
  confidence: string
  evidence: string
}

export const LINK_COLUMNS = columnsOf<ILinkRow>()([
  'parent_session_id',
  'parent_tool_call_id',
  'child_session_id',
  'kind',
  'confidence',
  'evidence',
])

export interface ISessionCommandRow {
  session_id: string
  message_id: string
  at: number
  command: string
  source: string
  has_file: number
}

export const SESSION_COMMAND_COLUMNS = columnsOf<ISessionCommandRow>()([
  'session_id',
  'message_id',
  'at',
  'command',
  'source',
  'has_file',
])

export interface ITurnRow {
  session_id: string
  message_id: string
  seq: number
  is_prompt: number
  requests: number
  tool_calls: number
  started_at: number
  ended_at: number
  model_ms: number
  tool_ms: number
  idle_ms: number
  human_wait_ms: number
  parent_turn_id: string | null
  parent_tool_call_id: string | null
}

export const TURN_COLUMNS = columnsOf<ITurnRow>()([
  'session_id',
  'message_id',
  'seq',
  'is_prompt',
  'requests',
  'tool_calls',
  'started_at',
  'ended_at',
  'model_ms',
  'tool_ms',
  'idle_ms',
  'human_wait_ms',
  'parent_turn_id',
  'parent_tool_call_id',
])

export interface ILabelRow {
  record_type: string
  record_id: string
  labeller: string
  version: number
  name: string
  value: string
  labelled_at: number
}

export const LABEL_COLUMNS = columnsOf<ILabelRow>()([
  'record_type',
  'record_id',
  'labeller',
  'version',
  'name',
  'value',
  'labelled_at',
])

export interface ILabelRunRow {
  id: number
  pid: number
  started_at: number
  ended_at: number | null
  outcome: string | null
  error: string | null
  model: string
}

export const LABEL_RUN_COLUMNS = columnsOf<ILabelRunRow>()([
  'id',
  'pid',
  'started_at',
  'ended_at',
  'outcome',
  'error',
  'model',
])

export interface ILabelRunTaskRow {
  run_id: number
  task: string
  version: number
  planned: number
  done: number
}

export const LABEL_RUN_TASK_COLUMNS = columnsOf<ILabelRunTaskRow>()(['run_id', 'task', 'version', 'planned', 'done'])

export interface IForgottenRow {
  session_id: string
  forgotten_at: number
}

export const FORGOTTEN_COLUMNS = columnsOf<IForgottenRow>()(['session_id', 'forgotten_at'])
