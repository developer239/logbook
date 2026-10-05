import {
  ADAPTER_ERROR_CODES,
  type IAdapterContext,
  type IFormatDrift,
  type IHarnessLocation,
  type ISourceReader,
  type ISourceUnit,
} from '@log-book/adapter-api'
import { LogBookError, type ISqliteDb } from '@log-book/core'
import { importSession } from './import-session.js'

// The newest of the 48 migrations of OpenCode 2.0.21, the release fixture set 2.0 comes from. The pull request that adds
// a fixture set for a newer version updates it.
export const NEWEST_TESTED_MIGRATION = '20260923013825_project_time_active'

// A migration id: a UTC timestamp, then its name.
const MIGRATION_ID = /^(?<stamp>\d{14})_/u

// Every column the adapter reads. It never queries another table or column, whatever the database holds.
const COLUMNS: Readonly<Record<string, { columns: readonly string[]; isRequired: boolean }>> = {
  session_v2: {
    columns: ['id', 'parent_id', 'directory', 'title', 'agent', 'version', 'time_created', 'time_updated'],
    isRequired: true,
  },
  session_message: {
    columns: ['id', 'session_id', 'type', 'seq', 'time_created', 'time_updated', 'data'],
    isRequired: true,
  },
  // Only in a database upgraded from OpenCode 1.x.
  message: { columns: ['id', 'session_id', 'data'], isRequired: false },
  // Read only for the format drift.
  migration: { columns: ['id'], isRequired: false },
}

const unsupported = (message: string): LogBookError =>
  new LogBookError(message, ADAPTER_ERROR_CODES.ADAPTER_FORMAT_UNSUPPORTED)

const tablesOf = (db: ISqliteDb): Set<string> =>
  new Set(
    (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]).map(
      (row) => row.name
    )
  )

const columnsOf = (db: ISqliteDb, table: string): Set<string> =>
  new Set((db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((row) => row.name))

// Every table and column the adapter reads exists; extra ones are ignored, as OpenCode adds columns often.
const checkSchema = (db: ISqliteDb): ReadonlySet<string> => {
  const tables = tablesOf(db)
  if (!tables.has('session_v2') && tables.has('session')) {
    throw unsupported('OpenCode 1.x database; start OpenCode 2 once to migrate it')
  }
  for (const [table, { columns, isRequired }] of Object.entries(COLUMNS)) {
    if (!tables.has(table)) {
      if (isRequired) {
        throw unsupported(`the database has no table ${table}`)
      }
      continue
    }
    const present = columnsOf(db, table)
    const missing = columns.find((column) => !present.has(column))
    if (missing !== undefined) {
      throw unsupported(`the database has no column ${table}.${missing}`)
    }
  }
  return tables
}

// The database's newest migration against the newest tested one: null when they agree or the database records none,
// the pair when the newest is later or cannot be placed. It never stops an import.
const formatDriftOf = (db: ISqliteDb, tables: ReadonlySet<string>): IFormatDrift | null => {
  if (!tables.has('migration')) {
    return null
  }
  const seen =
    (db.prepare('SELECT MAX(id) AS id FROM migration').get() as { id: string | null } | undefined)?.id ?? null
  if (seen === null) {
    return null
  }
  const stamp = MIGRATION_ID.exec(seen)?.groups?.stamp
  const tested = NEWEST_TESTED_MIGRATION.slice(0, 14)
  return stamp !== undefined && stamp <= tested ? null : { seen, testedUpTo: NEWEST_TESTED_MIGRATION }
}

interface ISessionRow {
  id: string
  updated: number
  messages: number
  last_message: number | null
}

// One unit per session_v2 row, a subagent session included; the fingerprint moves when the session row changes, a
// message is added or deleted, or one is edited in place.
const listSessions = (db: ISqliteDb, signal: AbortSignal): ISourceUnit[] => {
  signal.throwIfAborted()
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.time_updated AS updated, COUNT(m.id) AS messages, MAX(m.time_updated) AS last_message
       FROM session_v2 s LEFT JOIN session_message m ON m.session_id = s.id
       GROUP BY s.id ORDER BY s.id`
    )
    .all() as ISessionRow[]
  return rows.map((row) => ({
    locator: row.id,
    fingerprint: `${String(row.updated)}:${String(row.messages)}:${String(row.last_message ?? 0)}`,
  }))
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// Opens the database read-only once per sync, while OpenCode may be writing it, never with immutable=1, which could
// read a torn state. Reads are separate statements, not one transaction, so OpenCode's write-ahead log can still
// checkpoint. Whatever fails, the handle is closed before openSource throws.
export const openDatabase = async (location: IHarnessLocation, context: IAdapterContext): Promise<ISourceReader> => {
  let db: ISqliteDb
  try {
    db = await context.openSqlite(location.root, { isReadOnly: true })
  } catch (error: unknown) {
    throw new LogBookError(
      `Cannot open ${location.root}: ${reasonOf(error)}`,
      ADAPTER_ERROR_CODES.ADAPTER_SOURCE_UNREADABLE,
      error
    )
  }
  try {
    const tables = checkSchema(db)
    const formatDrift = formatDriftOf(db, tables)
    return {
      formatDrift,
      listUnits: async () => Promise.resolve(listSessions(db, context.signal)),
      importUnit: async (unit) => Promise.resolve(importSession(db, unit.locator, tables.has('message'))),
      close: async () => {
        db.close()
        await Promise.resolve()
      },
    }
  } catch (error: unknown) {
    db.close()
    if (error instanceof LogBookError) {
      throw error
    }
    throw new LogBookError(
      `Cannot read ${location.root}: ${reasonOf(error)}`,
      ADAPTER_ERROR_CODES.ADAPTER_SOURCE_UNREADABLE,
      error
    )
  }
}
