import type { ISqliteDb } from '@log-book/core'
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
