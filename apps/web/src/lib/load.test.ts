import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as Errors from './errors'
import type * as Load from './load'
import { insert, openSchema } from './testing/warehouse'

// The warehouse is opened once per module, so each case imports load afresh
// against the warehouse it names.
const importAt = async (path: string): Promise<typeof Load & typeof Errors> => {
  vi.stubEnv('TELEMETRY_DB', path)
  vi.resetModules()
  return { ...(await import('./load')), ...(await import('./errors')) }
}

let directory = ''
let warehouse = ''

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'logbook-load-'))
  warehouse = join(directory, 'telemetry.db')

  const db = openSchema(warehouse)
  insert(db, 'source_state', {
    source: 'claude-code',
    locator: 'transcripts',
    fingerprint: 'abc',
    parser_version: 1,
    imported_at: 42,
  })
  db.close()
})

afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true })
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
    const { load } = await importAt(join(directory, 'missing.db'))

    const page = load(() => 1)

    expect(page).toMatchObject({ ok: false, status: 503, syncedAt: null })
    expect(page.ok ? '' : page.problem).toContain('Run the cookbook sync first.')
  })

  it('should answer a warehouse at another schema version with 503 and the versions', async () => {
    const older = join(directory, 'older.db')
    const db = openSchema(older)
    db.exec('PRAGMA user_version = 9')
    db.close()

    const { load } = await importAt(older)

    const page = load(() => 1)

    expect(page).toMatchObject({ ok: false, status: 503, syncedAt: null })
    expect(page.ok ? '' : page.problem).toContain('schema 9; this app reads 10')
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
