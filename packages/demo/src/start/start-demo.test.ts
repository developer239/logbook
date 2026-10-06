import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEMO_ERROR_CODES } from '../errors.js'
import { START_DEMO_URL, startDemo } from './start-demo.js'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const ALLOWLIST = join(REPOSITORY_ROOT, 'packages/engine/network-call-sites.json')

describe('startDemo', () => {
  it('throws DEMO_TZ_NOT_UTC in a worker of another zone, and starts nothing', async () => {
    // Arrange
    const out = await mkdtemp(join(tmpdir(), 'demo-start-'))

    // Act
    const starting = startDemo({ out })

    // Assert
    try {
      await expect(starting).rejects.toMatchObject({ code: DEMO_ERROR_CODES.DEMO_TZ_NOT_UTC })
      expect(existsSync(join(out, 'warehouse.db.host'))).toBe(false)
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })

  it('is listed in the network allowlist as a local call site, by its own path', async () => {
    // Arrange
    const sites = JSON.parse(await readFile(ALLOWLIST, 'utf8')) as { file: string; case: string }[]
    const file = relative(REPOSITORY_ROOT, fileURLToPath(START_DEMO_URL))

    // Act
    const entries = sites.filter((site) => site.file === file).map((site) => site.case)

    // Assert
    expect(entries).toStrictEqual(['local'])
  })
})
