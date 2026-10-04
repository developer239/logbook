import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqlite, type ISqliteDb } from '@log-book/core'
import { applyMigrations, SCHEMA_VERSION } from '../migrations.js'

const IN_MEMORY = ':memory:'

export interface ITestWarehouseOptions {
  // Apply the migrations up to this version only; all of them when omitted.
  version?: number
  // Build the warehouse in memory instead of in a temporary file.
  isInMemory?: boolean
}

export interface ITestWarehouse {
  db: ISqliteDb
  // The warehouse file, or ':memory:'.
  path: string
  // Closes the connection and deletes the temporary directory.
  remove: () => Promise<void>
}

// The real migrations, never a copy of the DDL, so a test warehouse cannot drift from the product's.
export const createTestWarehouse = async ({
  version = SCHEMA_VERSION,
  isInMemory = false,
}: ITestWarehouseOptions = {}): Promise<ITestWarehouse> => {
  const directory = isInMemory ? null : await mkdtemp(join(tmpdir(), 'log-book-warehouse-'))
  const path = directory === null ? IN_MEMORY : join(directory, 'warehouse.db')
  const db = await openSqlite(path, { isReadOnly: false })
  applyMigrations(db, version)
  return {
    db,
    path,
    remove: async () => {
      db.close()
      if (directory !== null) {
        await rm(directory, { recursive: true, force: true })
      }
    },
  }
}

// Inserts one row by column name; a column the row leaves out takes the schema's default.
export const insert = (db: ISqliteDb, table: string, row: Record<string, string | number | null>): void => {
  const columns = Object.keys(row)
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
    ...Object.values(row)
  )
}
