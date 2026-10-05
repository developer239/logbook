-- Printed by sqlite3 (.schema) from the real warehouse, without the part_fts
-- shadow tables, which the virtual table creates. Regenerate it, with the
-- user_version, when the app moves to a new schema version.
CREATE TABLE source_state (
    source TEXT NOT NULL,
    locator TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    parser_version INTEGER NOT NULL,
    imported_at INTEGER NOT NULL,
    PRIMARY KEY (source, locator)
  );
CREATE TABLE session (
    id TEXT PRIMARY KEY,
    harness TEXT NOT NULL,
    source_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    project_dir TEXT,
    title TEXT,
    agent TEXT,
    spawned_by_session_id TEXT,
    spawned_by_tool_call_id TEXT,
    started_at INTEGER,
    ended_at INTEGER
  , is_scripted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX session_started_idx ON session (started_at);
CREATE TABLE message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    actor TEXT NOT NULL,
    source_role TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    model TEXT,
    agent TEXT,
    git_branch TEXT,
    tokens_input INTEGER,
    tokens_output INTEGER,
    tokens_reasoning INTEGER,
    tokens_cache_read INTEGER,
    tokens_cache_write INTEGER,
    reported_cost REAL
  );
CREATE INDEX message_session_idx ON message (session_id, seq);
CREATE TABLE part (
    rowid INTEGER PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    tool_call_id TEXT
  );
CREATE INDEX part_message_idx ON part (message_id, idx);
CREATE INDEX part_session_idx ON part (session_id);
CREATE INDEX part_tool_call_idx ON part (tool_call_id);
CREATE VIRTUAL TABLE part_fts USING fts5(text, content='part', content_rowid='rowid', tokenize='unicode61')
/* part_fts(text) */;
CREATE TRIGGER part_fts_insert AFTER INSERT ON part BEGIN
    INSERT INTO part_fts (rowid, text) VALUES (new.rowid, new.text);
  END;
CREATE TRIGGER part_fts_delete AFTER DELETE ON part BEGIN
    INSERT INTO part_fts (part_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;
CREATE TABLE tool_call (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    name TEXT NOT NULL,
    family TEXT NOT NULL,
    input_json TEXT NOT NULL,
    status TEXT NOT NULL,
    child_session_id TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    timing_source TEXT
  );
CREATE INDEX tool_call_session_idx ON tool_call (session_id);
CREATE INDEX tool_call_name_idx ON tool_call (name);
CREATE INDEX tool_call_child_idx ON tool_call (child_session_id);
CREATE TABLE event (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    data_json TEXT NOT NULL
  );
CREATE INDEX event_session_idx ON event (session_id, at);
CREATE TABLE run (
    run_id TEXT PRIMARY KEY,
    runner TEXT NOT NULL,
    mode TEXT,
    model TEXT,
    variant TEXT,
    agent TEXT,
    command TEXT,
    label TEXT,
    status TEXT NOT NULL,
    prompt TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    child_session_id TEXT,
    caller_kind TEXT,
    caller_session_id TEXT,
    caller_tool_call_id TEXT,
    caller_process TEXT
  , exit_code INTEGER, failure_kind TEXT, error TEXT, usage_limit_window TEXT, context_peak_tokens INTEGER, context_window_tokens INTEGER);
CREATE INDEX run_child_idx ON run (child_session_id);
CREATE TABLE link (
    parent_session_id TEXT NOT NULL,
    parent_tool_call_id TEXT,
    child_session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    run_id TEXT,
    confidence TEXT NOT NULL,
    evidence TEXT NOT NULL
  );
CREATE INDEX link_child_idx ON link (child_session_id);
CREATE INDEX link_parent_idx ON link (parent_session_id);
CREATE TABLE session_command (
    session_id TEXT NOT NULL,
    message_id TEXT,
    at INTEGER NOT NULL,
    command TEXT NOT NULL,
    source TEXT NOT NULL,
    work_type TEXT
  );
CREATE INDEX session_command_session_idx ON session_command (session_id);
CREATE TABLE label (
    record_type TEXT NOT NULL,
    record_id TEXT NOT NULL,
    labeller TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    labelled_at INTEGER NOT NULL,
    PRIMARY KEY (record_type, record_id, labeller, version, name)
  );
CREATE TABLE turn (
    session_id TEXT NOT NULL,
    message_id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    is_prompt INTEGER NOT NULL,
    requests INTEGER NOT NULL,
    tool_calls INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    model_ms INTEGER NOT NULL,
    tool_ms INTEGER NOT NULL,
    idle_ms INTEGER NOT NULL,
    human_wait_ms INTEGER NOT NULL,
    parent_turn_id TEXT,
    parent_tool_call_id TEXT
  );
CREATE INDEX turn_session_idx ON turn (session_id, seq);
CREATE INDEX turn_parent_turn_idx ON turn (parent_turn_id);
CREATE INDEX turn_parent_tool_call_idx ON turn (parent_tool_call_id);
CREATE TABLE tool (
    module TEXT NOT NULL,
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    input_schema TEXT NOT NULL,
    is_in_claude_code INTEGER NOT NULL
  );

PRAGMA user_version = 10;
