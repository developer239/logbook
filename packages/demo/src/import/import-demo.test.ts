import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IMPORT_DEMO_URL } from './import-demo.js'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const ALLOWLIST = join(REPOSITORY_ROOT, 'packages/engine/network-call-sites.json')

describe('import-demo', () => {
  it('is listed in the network allowlist as a local call site, by its own path', async () => {
    // Arrange
    const sites = JSON.parse(await readFile(ALLOWLIST, 'utf8')) as { file: string; case: string }[]
    const file = relative(REPOSITORY_ROOT, fileURLToPath(IMPORT_DEMO_URL))

    // Act
    const entries = sites.filter((site) => site.file === file).map((site) => site.case)

    // Assert
    expect(entries).toStrictEqual(['local'])
  })
})
