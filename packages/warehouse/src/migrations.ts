import { ERROR_CODES, LogBookError, type ISqliteDb } from '@log-book/core'

// Rules for every migration after version 1. A merged migration is never edited: a warehouse that applied it would
// never apply the edit, so a later change appends a string. Each entry carries a one-line comment saying what it
// changes and which of rules 1 to 4 apply.
//
// 1. An imported column (one an adapter fills) is nullable or has a default meaning "not recorded": sessions whose
//    source the harness has deleted are never re-imported, so a new imported column stays empty for them forever.
// 2. A migration that adds or changes an imported column ships with a parser version bump in every adapter that
//    fills it, so the next sync re-imports every unit still on disk.
// 3. Derived tables (link, session_command, turn, and the rules labeller's label rows) may be dropped and
//    recreated; the next sync fills them.
// 4. Model labels (every label row whose labeller is not rules), forgotten, label_run and label_run_task rows are
//    carried across. A change to their shape transforms them in place in the same step; it never drops them.
// 5. Rebuilding part, tool_call or message is a last resort (minutes and free disk equal to the table on a
//    gigabyte-sized warehouse); prefer ALTER TABLE ... ADD COLUMN.
// 6. A migration that drops or renames a column, or narrows a column's values, is a breaking change of the
//    package's public API and ships in a major release; a new table or a new nullable column is not.
export const MIGRATIONS: readonly string[] = [
  // Version 1: creates the schema; rules 1 to 4 have no earlier rows to apply to.
  `
CREATE TABLE harness (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  default_agent TEXT NOT NULL,
  filter_alias TEXT NOT NULL UNIQUE,
  is_found INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  location TEXT,
  location_variables TEXT NOT NULL,
  version_seen TEXT,
  notice TEXT,
  problem TEXT
) STRICT;

CREATE TABLE source_state (
  harness TEXT NOT NULL,
  locator TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (harness, locator)
) STRICT, WITHOUT ROWID;

CREATE TABLE sync_run (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,
  error TEXT
) STRICT;

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  source_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  is_scripted INTEGER NOT NULL,
  project_dir TEXT,
  title TEXT,
  agent TEXT,
  spawned_by_session_id TEXT,
  spawned_by_tool_call_id TEXT,
  started_at INTEGER,
  ended_at INTEGER
) STRICT;
CREATE INDEX session_started_idx ON session (started_at);

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  actor TEXT NOT NULL,
  source_role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  requested_at INTEGER,
  model TEXT,
  agent TEXT,
  git_branch TEXT,
  tokens_input INTEGER,
  tokens_output INTEGER,
  tokens_reasoning INTEGER,
  tokens_cache_read INTEGER,
  tokens_cache_write INTEGER,
  reported_cost REAL
) STRICT;
CREATE INDEX message_session_idx ON message (session_id, seq);

CREATE TABLE part (
  rowid INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  tool_call_id TEXT
) STRICT;
CREATE INDEX part_message_idx ON part (message_id, idx);
CREATE INDEX part_session_idx ON part (session_id);
CREATE INDEX part_tool_call_idx ON part (tool_call_id);

CREATE VIRTUAL TABLE part_fts USING fts5(text, content='part', content_rowid='rowid', tokenize='unicode61');
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
  bare_name TEXT NOT NULL,
  server TEXT,
  family TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL,
  child_session_id TEXT,
  started_at INTEGER,
  ended_at INTEGER
) STRICT;
CREATE INDEX tool_call_session_idx ON tool_call (session_id);
CREATE INDEX tool_call_name_idx ON tool_call (name);
CREATE INDEX tool_call_child_idx ON tool_call (child_session_id);

CREATE TABLE event (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  data_json TEXT NOT NULL
) STRICT;
CREATE INDEX event_session_idx ON event (session_id, at);

CREATE TABLE link (
  parent_session_id TEXT NOT NULL,
  parent_tool_call_id TEXT,
  child_session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  confidence TEXT NOT NULL,
  evidence TEXT NOT NULL
) STRICT;
CREATE INDEX link_child_idx ON link (child_session_id);
CREATE INDEX link_parent_idx ON link (parent_session_id);

CREATE TABLE session_command (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  command TEXT NOT NULL,
  source TEXT NOT NULL,
  has_file INTEGER NOT NULL
) STRICT;
CREATE INDEX session_command_session_idx ON session_command (session_id);

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
) STRICT;
CREATE INDEX turn_session_idx ON turn (session_id, seq);
CREATE INDEX turn_parent_turn_idx ON turn (parent_turn_id);
CREATE INDEX turn_parent_tool_call_idx ON turn (parent_tool_call_id);

CREATE TABLE label (
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  labeller TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  labelled_at INTEGER NOT NULL,
  PRIMARY KEY (record_type, record_id, labeller, version, name)
) STRICT, WITHOUT ROWID;

CREATE TABLE label_run (
  id INTEGER PRIMARY KEY,
  pid INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,
  error TEXT,
  model TEXT NOT NULL
) STRICT;

CREATE TABLE label_run_task (
  run_id INTEGER NOT NULL,
  task TEXT NOT NULL,
  version INTEGER NOT NULL,
  planned INTEGER NOT NULL,
  done INTEGER NOT NULL,
  PRIMARY KEY (run_id, task)
) STRICT, WITHOUT ROWID;

CREATE TABLE forgotten (
  session_id TEXT PRIMARY KEY,
  forgotten_at INTEGER NOT NULL
) STRICT;
`,
]

export const SCHEMA_VERSION = MIGRATIONS.length

const readUserVersion = (db: ISqliteDb): number =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

// Applies every missing step up to targetVersion, each in its own BEGIN IMMEDIATE transaction. The version is read
// again inside the transaction, so a step another process applied meanwhile is skipped instead of run twice.
export const applyMigrations = (db: ISqliteDb, targetVersion: number = SCHEMA_VERSION): void => {
  if (targetVersion > SCHEMA_VERSION) {
    throw new LogBookError(
      `Schema version ${String(targetVersion)} does not exist; the newest is ${String(SCHEMA_VERSION)}.`,
      ERROR_CODES.VALIDATION_ERROR
    )
  }
  const current = readUserVersion(db)
  for (const [offset, migration] of MIGRATIONS.slice(current, targetVersion).entries()) {
    const step = current + offset + 1
    db.exec('BEGIN IMMEDIATE')
    try {
      if (readUserVersion(db) < step) {
        db.exec(migration)
        db.exec(`PRAGMA user_version = ${String(step)}`)
      }
      db.exec('COMMIT')
    } catch (error: unknown) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
