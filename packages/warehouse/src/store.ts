import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { LogBookError, openSqlite, type ISqliteDb } from '@log-book/core'
import { WAREHOUSE_ERROR_CODES, WarehouseVersionError } from './errors.js'
import { applyMigrations, readUserVersion, SCHEMA_VERSION } from './migrations.js'
import { resolveDataDirectory } from './paths.js'
import type {
  IHarnessDescriptorRecord,
  IHarnessStepRecord,
  IImportedSession,
  ISourceStateRecord,
  ISyncEndRecord,
} from './records.js'

// The warehouse holds whole conversations, and so do its write-ahead log and shared-memory files until a checkpoint:
// readable by the owner only.
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
// Truncates the write-ahead log after a checkpoint, so one large unit does not leave a log of hundreds of megabytes
// behind while a reader holds a snapshot.
const JOURNAL_SIZE_LIMIT_BYTES = 67_108_864
// Only the newest sync record has a reader; the rest are kept for `logbook sql` up to this many.
const SYNC_RECORDS_KEPT = 100

type TSqlParam = string | number | null

export type SourceState = Pick<ISourceStateRecord, 'fingerprint' | 'parserVersion'>

const SQLITE_BUSY = 5
const WAL_SWITCH_ATTEMPTS = 50
const WAL_SWITCH_RETRY_MS = 100

// What a reader of the warehouse may do: read rows as plain objects, and close.
export interface IWarehouseReader {
  all: <TRow>(sql: string, ...params: TSqlParam[]) => TRow[]
  get: <TRow>(sql: string, ...params: TSqlParam[]) => TRow | undefined
  close: () => void
}

const isBusy = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'errcode' in error && error.errcode === SQLITE_BUSY

// Two processes switching the same file to WAL at once both hold a shared lock and want an exclusive one; to avoid a
// deadlock SQLite answers one of them SQLITE_BUSY at once instead of waiting through the busy timeout. That process
// backs off, which releases its lock, the other switches the file, and the retry finds it in WAL mode already.
const switchToWal = async (db: ISqliteDb, attemptsLeft: number = WAL_SWITCH_ATTEMPTS): Promise<void> => {
  try {
    db.exec('PRAGMA journal_mode = WAL')
  } catch (error: unknown) {
    if (!isBusy(error) || attemptsLeft <= 1) {
      throw error
    }
    await delay(WAL_SWITCH_RETRY_MS)
    await switchToWal(db, attemptsLeft - 1)
  }
}

const isInside = (parent: string, child: string): boolean => {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

// The directory is Log Book's own when it created it or when it lies inside the data directory; a directory of the
// user's that a LOGBOOK_DB override points into keeps its mode.
const tightenModes = (path: string, isDirectoryOwned: boolean): void => {
  if (isDirectoryOwned) {
    chmodSync(dirname(path), DIRECTORY_MODE)
  }
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) {
      chmodSync(file, FILE_MODE)
    }
  }
}

// The warehouse database. open() is the only way to write it; every write goes through a typed method, and the store
// never reads the clock: every time it writes comes from its caller.
export class WarehouseStore implements IWarehouseReader {
  // The version the file had when it was opened, and the version it has now.
  public readonly previousVersion: number
  public readonly version: number
  private readonly db: ISqliteDb

  private constructor(db: ISqliteDb, previousVersion: number, version: number) {
    this.db = db
    this.previousVersion = previousVersion
    this.version = version
  }

  // Creates a missing directory and file, refuses a newer warehouse before changing a byte, and migrates an older one.
  public static readonly open = async (path: string): Promise<WarehouseStore> => {
    const directory = dirname(path)
    const isDirectoryNew = !existsSync(directory)
    if (isDirectoryNew) {
      mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
    }
    const db = await openSqlite(path, { isReadOnly: false })
    const previousVersion = readUserVersion(db)
    if (previousVersion > SCHEMA_VERSION) {
      db.close()
      throw new WarehouseVersionError(
        `The warehouse ${path} is at version ${String(previousVersion)}, newer than this build's ${String(SCHEMA_VERSION)}.`,
        WAREHOUSE_ERROR_CODES.WAREHOUSE_SCHEMA_NEWER,
        previousVersion,
        SCHEMA_VERSION
      )
    }
    const isDirectoryOwned = isDirectoryNew || isInside(resolveDataDirectory(), directory)
    // Before the write-ahead log exists, so SQLite creates its files with the warehouse's mode.
    tightenModes(path, isDirectoryOwned)
    await switchToWal(db)
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec(`PRAGMA journal_size_limit = ${String(JOURNAL_SIZE_LIMIT_BYTES)}`)
    applyMigrations(db)
    tightenModes(path, isDirectoryOwned)
    return new WarehouseStore(db, previousVersion, SCHEMA_VERSION)
  }

  // Opens for reading only, and only a warehouse at this build's version: under the host, the host has migrated it
  // before a reader opens it. A reader re-checks the version per request, because a newer build can migrate the file.
  public static readonly openReadOnly = async (path: string): Promise<IWarehouseReader> => {
    if (!existsSync(path)) {
      throw new LogBookError(`No warehouse at ${path}.`, WAREHOUSE_ERROR_CODES.WAREHOUSE_NOT_FOUND)
    }
    const db = await openSqlite(path, { isReadOnly: true })
    const version = readUserVersion(db)
    if (version !== SCHEMA_VERSION) {
      db.close()
      throw new WarehouseVersionError(
        `The warehouse ${path} is at version ${String(version)}; this build reads version ${String(SCHEMA_VERSION)}.`,
        WAREHOUSE_ERROR_CODES.WAREHOUSE_SCHEMA_MISMATCH,
        version,
        SCHEMA_VERSION
      )
    }
    return new WarehouseStore(db, version, version)
  }

  // node:sqlite returns rows without a prototype; readers get plain objects.
  public readonly all = <TRow>(sql: string, ...params: TSqlParam[]): TRow[] =>
    this.db
      .prepare(sql)
      .all(...params)
      .map((row) => ({ ...(row as object) }) as TRow)

  public readonly get = <TRow>(sql: string, ...params: TSqlParam[]): TRow | undefined => {
    const row = this.db.prepare(sql).get(...params)
    return row === undefined ? undefined : ({ ...(row as object) } as TRow)
  }

  public readonly close = (): void => this.db.close()

  // The fingerprint and parser version stored for a unit, or null when it was never imported.
  public readonly readSourceState = (harness: string, locator: string): SourceState | null => {
    const row = this.get<{ fingerprint: string; parser_version: number }>(
      'SELECT fingerprint, parser_version FROM source_state WHERE harness = ? AND locator = ?',
      harness,
      locator
    )
    return row === undefined ? null : { fingerprint: row.fingerprint, parserVersion: row.parser_version }
  }

  // Replaces everything held for each session of one unit with what the adapter imported, and records the unit's
  // source state, in one transaction: a reader sees the unit old or new, never half. A session the user forgot is left
  // out, and a session the unit no longer produces keeps its rows. Labels are never touched: ids are stable across
  // imports, so they still point at the same records.
  public readonly writeImportedUnit = (
    sessions: readonly IImportedSession[],
    sourceState: ISourceStateRecord
  ): void => {
    this.transaction(() => {
      const isForgotten = this.db.prepare('SELECT 1 FROM forgotten WHERE session_id = ?')
      for (const imported of sessions) {
        if (isForgotten.get(imported.session.id) === undefined) {
          this.deleteSession(imported.session.id)
          this.insertSession(imported)
        }
      }
      this.db
        .prepare(
          `INSERT INTO source_state (harness, locator, fingerprint, parser_version, imported_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (harness, locator) DO UPDATE SET fingerprint = excluded.fingerprint,
             parser_version = excluded.parser_version, imported_at = excluded.imported_at`
        )
        .run(
          sourceState.harness,
          sourceState.locator,
          sourceState.fingerprint,
          sourceState.parserVersion,
          sourceState.importedAt
        )
    })
  }

  // One upsert per registered adapter at the start of a sync, in one transaction. The step-end columns (version_seen,
  // notice, problem) keep their values, and a harness missing from the list keeps its row and its name.
  public readonly writeHarnessDescriptors = (descriptors: readonly IHarnessDescriptorRecord[]): void => {
    this.transaction(() => {
      const upsert = this.db.prepare(
        `INSERT INTO harness (id, name, default_agent, filter_alias, is_found, checked_at, location, location_variables)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, default_agent = excluded.default_agent,
           filter_alias = excluded.filter_alias, is_found = excluded.is_found, checked_at = excluded.checked_at,
           location = excluded.location, location_variables = excluded.location_variables`
      )
      for (const descriptor of descriptors) {
        upsert.run(
          descriptor.id,
          descriptor.name,
          descriptor.defaultAgent,
          descriptor.filterAlias,
          descriptor.isFound ? 1 : 0,
          descriptor.checkedAt,
          descriptor.location,
          JSON.stringify(descriptor.locationVariables)
        )
      }
    })
  }

  // At the end of one adapter's step: all three columns every time, null meaning none.
  public readonly writeHarnessStepEnd = (harnessId: string, step: IHarnessStepRecord): void => {
    this.db
      .prepare('UPDATE harness SET version_seen = ?, notice = ?, problem = ? WHERE id = ?')
      .run(step.versionSeen, step.notice, step.problem, harnessId)
  }

  // Inserts the sync's record and returns its id; the same transaction deletes all but the newest records.
  public readonly startSyncRecord = (startedAt: number): number =>
    this.transaction(() => {
      this.db.prepare('INSERT INTO sync_run (started_at) VALUES (?)').run(startedAt)
      const { id } = this.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }
      this.db
        .prepare('DELETE FROM sync_run WHERE id NOT IN (SELECT id FROM sync_run ORDER BY id DESC LIMIT ?)')
        .run(SYNC_RECORDS_KEPT)
      return id
    })

  public readonly endSyncRecord = (id: number, end: ISyncEndRecord): void => {
    this.db
      .prepare('UPDATE sync_run SET ended_at = ?, outcome = ?, error = ? WHERE id = ?')
      .run(end.endedAt, end.outcome, end.error, id)
  }

  private readonly transaction = <TResult>(work: () => TResult): TResult => {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // In this order, so the part delete trigger keeps part_fts in step before the rest goes.
  private readonly deleteSession = (sessionId: string): void => {
    for (const table of ['part', 'message', 'tool_call', 'event']) {
      this.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId)
    }
    this.db.prepare('DELETE FROM session WHERE id = ?').run(sessionId)
  }

  private readonly insertSession = ({ session, messages, parts, toolCalls, events }: IImportedSession): void => {
    this.db
      .prepare(
        `INSERT INTO session (id, harness, source_id, origin, is_scripted, project_dir, title, agent,
           spawned_by_session_id, spawned_by_tool_call_id, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.harness,
        session.sourceId,
        session.origin,
        session.isScripted ? 1 : 0,
        session.projectDir,
        session.title,
        session.agent,
        session.spawnedBySessionId,
        session.spawnedByToolCallId,
        session.startedAt,
        session.endedAt
      )

    const insertMessage = this.db.prepare(
      `INSERT INTO message (id, session_id, seq, actor, source_role, created_at, completed_at, requested_at, model, agent,
         git_branch, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, reported_cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const message of messages) {
      insertMessage.run(
        message.id,
        message.sessionId,
        message.seq,
        message.actor,
        message.sourceRole,
        message.createdAt,
        message.completedAt,
        message.requestedAt,
        message.model,
        message.agent,
        message.gitBranch,
        message.tokensInput,
        message.tokensOutput,
        message.tokensReasoning,
        message.tokensCacheRead,
        message.tokensCacheWrite,
        message.reportedCost
      )
    }

    const insertPart = this.db.prepare(
      'INSERT INTO part (message_id, session_id, idx, kind, text, tool_call_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
    for (const part of parts) {
      insertPart.run(part.messageId, part.sessionId, part.idx, part.kind, part.text, part.toolCallId)
    }

    const insertToolCall = this.db.prepare(
      `INSERT INTO tool_call (id, session_id, message_id, name, bare_name, server, family, input_json, status,
         child_session_id, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const call of toolCalls) {
      insertToolCall.run(
        call.id,
        call.sessionId,
        call.messageId,
        call.name,
        call.bareName,
        call.server,
        call.family,
        call.inputJson,
        call.status,
        call.childSessionId,
        call.startedAt,
        call.endedAt
      )
    }

    const insertEvent = this.db.prepare(
      'INSERT INTO event (id, session_id, kind, at, data_json) VALUES (?, ?, ?, ?, ?)'
    )
    for (const event of events) {
      insertEvent.run(event.id, event.sessionId, event.kind, event.at, event.dataJson)
    }
  }
}
