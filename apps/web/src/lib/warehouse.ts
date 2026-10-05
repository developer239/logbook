import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { WarehouseError } from './errors'

// The cookbook bumps its schema version whenever a table changes, so a
// warehouse at another version is refused rather than read wrongly.
const WAREHOUSE_SCHEMA_VERSION = 10

const warehousePath = (): string =>
  process.env['TELEMETRY_DB'] ??
  join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'cookbook', 'telemetry.db')

let connection: DatabaseSync | undefined

const statements = new Map<string, StatementSync>()

const open = (): DatabaseSync => {
  const path = warehousePath()
  if (!existsSync(path)) {
    throw new WarehouseError(`No warehouse at ${path}. Run the cookbook sync first.`)
  }

  return new DatabaseSync(path, { readOnly: true })
}

const warehouse = (): DatabaseSync => {
  connection ??= open()
  return connection
}

// A cookbook sync can migrate the warehouse while the app runs, so a page
// checks its schema once before it reads anything (load does).
export const checkSchema = (): void => {
  const { user_version: version } = warehouse().prepare('PRAGMA user_version').get() as { user_version: number }
  if (version !== WAREHOUSE_SCHEMA_VERSION) {
    throw new WarehouseError(
      `The warehouse is at schema ${String(version)}; this app reads ${String(WAREHOUSE_SCHEMA_VERSION)}. Update the app or the cookbook so they match.`
    )
  }
}

// SQLite prepares a statement again itself when the schema changes under it.
const statement = (sql: string): StatementSync => {
  const prepared = statements.get(sql) ?? warehouse().prepare(sql)
  statements.set(sql, prepared)
  return prepared
}

export const all = <TRow>(sql: string, ...params: SQLInputValue[]): TRow[] =>
  statement(sql).all(...params) as unknown as TRow[]

export const get = <TRow>(sql: string, ...params: SQLInputValue[]): TRow | undefined =>
  statement(sql).get(...params) as unknown as TRow | undefined

export const syncedAt = (): number | null =>
  get<{ at: number | null }>('SELECT MAX(imported_at) AS at FROM source_state')?.at ?? null
