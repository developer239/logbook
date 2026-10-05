import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { vi } from 'vitest'

export const openSchema = (path = ':memory:'): DatabaseSync => {
  const db = new DatabaseSync(path)
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'))
  return db
}

// A column the row leaves out takes the schema's default.
export const insert = (db: DatabaseSync, table: string, row: Record<string, SQLInputValue>): void => {
  const columns = Object.keys(row)
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
    ...Object.values(row)
  )
}

export interface ITestWarehouse {
  remove: () => void
}

// The app opens its warehouse once per module, so a test imports the modules it
// exercises after this call.
export const seedWarehouse = (seed: (db: DatabaseSync) => void): ITestWarehouse => {
  const directory = mkdtempSync(join(tmpdir(), 'logbook-warehouse-'))
  const path = join(directory, 'telemetry.db')

  const db = openSchema(path)
  seed(db)
  db.close()

  vi.stubEnv('TELEMETRY_DB', path)
  vi.resetModules()

  return {
    remove: () => {
      vi.unstubAllEnvs()
      rmSync(directory, { recursive: true })
    },
  }
}
