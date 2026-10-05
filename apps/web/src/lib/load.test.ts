import { join } from 'node:path'
import { SCHEMA_VERSION } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as Errors from './errors'
import type * as Load from './load'

// The warehouse is opened once per module, so each case imports load afresh
// against the warehouse it names.
const importAt = async (path: string): Promise<typeof Load & typeof Errors> => {
  vi.stubEnv('LOGBOOK_DB', path)
  vi.resetModules()
  return { ...(await import('./load')), ...(await import('./errors')) }
}

let current: ITestWarehouse
let warehouse = ''

beforeAll(async () => {
  current = await createTestWarehouse()
  warehouse = current.path

  insert(current.db, 'source_state', {
    harness: 'claude-code',
    locator: 'transcripts',
    fingerprint: 'abc',
    parser_version: 1,
    imported_at: 42,
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await current.remove()
})

describe('load', () => {
  it('should answer a parameter the page does not read with 400 and its reason', async () => {
    const { load, ParamError } = await importAt(warehouse)

    const page = load(() => {
      throw new ParamError('page must be a whole number, got x')
    })

    expect(page).toEqual({ ok: false, problem: 'page must be a whole number, got x', status: 400, syncedAt: 42 })
  })

  it('should answer something the URL names that is not there with 404', async () => {
    const { load, NotFoundError } = await importAt(warehouse)

    const page = load(() => {
      throw new NotFoundError('No conversation abc')
    })

    expect(page).toMatchObject({ ok: false, problem: 'No conversation abc', status: 404 })
  })

  it('should answer a missing warehouse with 503 and the way to fix it', async () => {
    const missing = join(warehouse, '..', 'missing.db')
    const { load } = await importAt(missing)

    const page = load(() => 1)

    expect(page).toMatchObject({ ok: false, status: 503, syncedAt: null })
    expect(page.ok ? '' : page.problem).toBe(`There is no warehouse at ${missing} yet.`)
  })

  it('should answer a warehouse at another schema version with 503 and the versions', async () => {
    const newer = await createTestWarehouse()
    newer.db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION + 1)}`)

    const { load } = await importAt(newer.path)

    const page = load(() => 1)
    await newer.remove()

    expect(page).toMatchObject({ ok: false, status: 503, syncedAt: null })
    expect(page.ok ? '' : page.problem).toBe(
      `This warehouse is at schema ${String(SCHEMA_VERSION + 1)}; this Log Book reads ${String(SCHEMA_VERSION)}.`
    )
  })

  it('should throw what is not a problem a page can show', async () => {
    const { load } = await importAt(warehouse)

    expect(() =>
      load(() => {
        throw new Error('a bug here')
      })
    ).toThrow('a bug here')
  })
})
