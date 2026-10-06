import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqlite, type ISqliteDb } from '@log-book/core'
import { createTestWarehouse, insert } from '@log-book/warehouse/testing'
import { vi } from 'vitest'

export { insert }

export interface ITestWarehouse {
  path: string
  remove: () => Promise<void>
}

// The app opens its warehouse once per module, so a test imports the modules it
// exercises after this call.
export const seedWarehouse = async (seed: (db: ISqliteDb) => void): Promise<ITestWarehouse> => {
  const warehouse = await createTestWarehouse()
  seed(warehouse.db)

  vi.stubEnv('LOGBOOK_DB', warehouse.path)
  vi.resetModules()

  return {
    path: warehouse.path,
    remove: async () => {
      vi.unstubAllEnvs()
      await warehouse.remove()
    },
  }
}

export interface ICopiedWarehouse extends ITestWarehouse {
  // The copy, open for the odd row a test adds on top of it with `insert`.
  db: ISqliteDb
}

// A built warehouse (a demo set's) copied into the test's own directory, with the write-ahead log beside it, so no two
// tests share a file. LOGBOOK_DB names the copy for the test, and the app's modules are reset so they open it.
export const copyWarehouse = async (path: string): Promise<ICopiedWarehouse> => {
  const directory = await mkdtemp(join(tmpdir(), 'web-warehouse-'))
  const copy = join(directory, 'warehouse.db')
  await Promise.all(
    ['', '-wal', '-shm']
      .filter((suffix) => existsSync(`${path}${suffix}`))
      .map(async (suffix) => copyFile(`${path}${suffix}`, `${copy}${suffix}`))
  )
  const db = await openSqlite(copy, { isReadOnly: false })

  vi.stubEnv('LOGBOOK_DB', copy)
  vi.resetModules()

  return {
    path: copy,
    db,
    remove: async () => {
      db.close()
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
