import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findingLine } from '../scripts/k7.js'
import { checkK9 } from './k9.js'

const directories: string[] = []

const page = (body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>License</h1>${body}</body></html>`

// A built site of these pages, checked under /logbook/.
const linesFor = async (pages: Readonly<Record<string, string>>): Promise<string[]> => {
  const repository = await mkdtemp(join(tmpdir(), 'docs-k9-'))
  directories.push(repository)
  const built = join(repository, 'apps', 'docs', '.vitepress', 'dist')
  await Promise.all(
    Object.entries(pages).map(async ([file, html]) => {
      await mkdir(dirname(join(built, file)), { recursive: true })
      await writeFile(join(built, file), html)
    })
  )
  return (await checkK9({ built, basePath: '/logbook/', repository })).map(findingLine)
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('checkK9', () => {
  it('fails a built page with an image from another origin, naming the page and the URL in each scheme', async () => {
    // Act
    const lines = await linesFor({
      'index.html': page('<a href="/logbook/help/license">License</a>'),
      'help/license.html': page('<img src="https://example.com/x.png" alt="">'),
    })

    // Assert
    expect(lines).toStrictEqual([
      'K9 apps/docs/.vitepress/dist/help/license.html:1 /help/license (dark) asked another origin: https://example.com/x.png',
      'K9 apps/docs/.vitepress/dist/help/license.html:1 /help/license (light) asked another origin: https://example.com/x.png',
    ])
  })

  it('passes the same page without it, with its own image', async () => {
    // Act
    const lines = await linesFor({
      'help/license.html': page('<img src="/logbook/logo.svg" alt="">'),
      'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    })

    // Assert
    expect(lines).toStrictEqual([])
  })
})
