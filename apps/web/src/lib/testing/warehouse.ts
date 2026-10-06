import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqlite, type ISqliteDb } from '@log-book/core'
import { createTestWarehouse, insert } from '@log-book/warehouse/testing'
import { inject, vi } from 'vitest'

export { insert }

// A warehouse of the test's own, which LOGBOOK_DB names, open for the odd row a test adds with `insert`. The app opens
// its warehouse once per module, so a test imports the modules it exercises after taking one.
export interface ITestWarehouse {
  path: string
  db: ISqliteDb
  remove: () => Promise<void>
}

// The demo sets the web project's setup builds once per run.
export type DemoSet = 'demoSmall' | 'demoSmallNoLabels'

const useWarehouse = (path: string): void => {
  vi.stubEnv('LOGBOOK_DB', path)
  vi.resetModules()
}

// A built warehouse (a demo set's) copied into the test's own directory, with the write-ahead log beside it, so no two
// tests share a file.
export const copyWarehouse = async (path: string): Promise<ITestWarehouse> => {
  const directory = await mkdtemp(join(tmpdir(), 'web-warehouse-'))
  const copy = join(directory, 'warehouse.db')
  await Promise.all(
    ['', '-wal', '-shm']
      .filter((suffix) => existsSync(`${path}${suffix}`))
      .map(async (suffix) => copyFile(`${path}${suffix}`, `${copy}${suffix}`))
  )
  const db = await openSqlite(copy, { isReadOnly: false })
  useWarehouse(copy)

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

// A copy of one of the run's demo sets: the product's own adapters and engine wrote it.
export const copyDemo = async (set: DemoSet): Promise<ITestWarehouse> => copyWarehouse(inject(set).warehouse)

// A migrated warehouse with no row at all, for the states a warehouse is in before anything was imported.
export const emptyWarehouse = async (): Promise<ITestWarehouse> => {
  const warehouse = await createTestWarehouse()
  useWarehouse(warehouse.path)

  return {
    path: warehouse.path,
    db: warehouse.db,
    remove: async () => {
      vi.unstubAllEnvs()
      await warehouse.remove()
    },
  }
}
