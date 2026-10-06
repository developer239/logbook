import { SCHEMA_VERSION, WarehouseStore } from '@log-book/warehouse'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { copyWarehouse, insert, type ITestWarehouse } from '../src/lib/testing/warehouse'

const copies: ITestWarehouse[] = []

const copyOf = async (path: string): Promise<ITestWarehouse> => {
  const copy = await copyWarehouse(path)
  copies.push(copy)
  return copy
}

const count = (copy: ITestWarehouse, sql: string): unknown => (copy.db.prepare(sql).get() as { count: number }).count

afterEach(async () => {
  await Promise.all(copies.splice(0).map(async (copy) => copy.remove()))
})

describe('the demo sets of the web test run', () => {
  it('provide a plan with sessions and a warehouse that opens at the current schema', async () => {
    // Arrange
    const small = inject('demoSmall')
    const copy = await copyOf(small.warehouse)

    // Act
    const reader = await WarehouseStore.openReadOnly(copy.path)
    const version = reader.get<{ user_version: number }>('PRAGMA user_version')?.user_version
    reader.close()

    // Assert
    expect({ hasSessions: small.plan.plan.sessions.length > 0, version }).toStrictEqual({
      hasSessions: true,
      version: SCHEMA_VERSION,
    })
  })

  it('give each copy a file of its own: a row added to one is absent from the other', async () => {
    // Arrange
    const { warehouse } = inject('demoSmall')
    const [first, second] = [await copyOf(warehouse), await copyOf(warehouse)]

    // Act
    insert(first.db, 'sync_run', { started_at: 1, ended_at: 2, outcome: 'ok', error: null })

    // Assert
    const sql = 'SELECT COUNT(*) AS count FROM sync_run WHERE started_at = 1'
    expect([count(first, sql), count(second, sql), first.path === second.path]).toStrictEqual([1, 0, false])
  })

  it('are built in UTC while the tests run in the configured zone', () => {
    // Act
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone

    // Assert
    expect({ zone, isBuilt: inject('demoSmall').out !== inject('demoSmallNoLabels').out }).toStrictEqual({
      zone: 'America/St_Johns',
      isBuilt: true,
    })
  })
})
