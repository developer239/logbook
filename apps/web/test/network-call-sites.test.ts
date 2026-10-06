import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SOURCES = join(ROOT, 'apps/web/src')
const ALLOWLIST = join(ROOT, 'packages/engine/network-call-sites.json')

// Each kind of call, and the one file of the web app that may make it.
const CALLS: readonly { needle: string; file: string }[] = [
  { needle: 'child_process', file: 'apps/web/src/lib/cli.ts' },
  { needle: 'fetch(', file: 'apps/web/src/scripts/follow.ts' },
]

const sourceFiles = async (): Promise<string[]> =>
  (await readdir(SOURCES, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.test.ts'))
    .map((entry) => join(entry.parentPath, entry.name))

describe("the web app's network call sites", () => {
  it('are listed in the allowlist exactly as the two local entries', async () => {
    // Arrange
    const sites = JSON.parse(await readFile(ALLOWLIST, 'utf8')) as { file: string; case: string }[]

    // Act
    const web = sites.filter((site) => site.file.startsWith('apps/web/')).map((site) => `${site.file} ${site.case}`)

    // Assert
    expect(web.toSorted()).toStrictEqual(['apps/web/src/lib/cli.ts local', 'apps/web/src/scripts/follow.ts local'])
  })

  it('start children only in cli.ts and fetch only in follow.ts', async () => {
    // Arrange
    const files = await sourceFiles()

    // Act
    const misplaced = (
      await Promise.all(
        files.map(async (path) => {
          const file = relative(ROOT, path)
          const lines = (await readFile(path, 'utf8')).split('\n')
          return CALLS.flatMap(({ needle, file: allowed }) =>
            file === allowed
              ? []
              : lines.flatMap((text, index) =>
                  text.includes(needle) ? [`${file}:${String(index + 1)} ${needle}`] : []
                )
          )
        })
      )
    ).flat()

    // Assert
    expect(misplaced).toStrictEqual([])
  })
})
