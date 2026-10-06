import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkK5 } from './k5.js'
import { findingLine } from './k7.js'

const SITE_URL = 'https://developer239.github.io/logbook/'
const directories: string[] = []

// A repository whose README holds this text.
const linesFor = async (readme: string): Promise<string[]> => {
  const repository = await mkdtemp(join(tmpdir(), 'docs-k5-'))
  directories.push(repository)
  await writeFile(join(repository, 'README.md'), readme)
  return (
    await checkK5({
      readme: join(repository, 'README.md'),
      repository,
      siteUrl: SITE_URL,
      shots: ['dashboard'],
      committed: ['dashboard-90-days.png'],
    })
  ).map(findingLine)
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('checkK5', () => {
  it("passes a shot's capture in either scheme and a committed capture", async () => {
    // Act
    const lines = await linesFor(
      `![The dashboard](${SITE_URL}captures/dashboard-dark.png)\n` +
        `<img src="${SITE_URL}captures/dashboard-light.png" alt="The dashboard">\n` +
        `![Ninety days](${SITE_URL}committed/dashboard-90-days.png)\n`
    )

    // Assert
    expect(lines).toStrictEqual([])
  })

  it('fails an image that is neither, naming the README and its line', async () => {
    // Act
    const lines = await linesFor('# Log Book\n\n![example](https://example.com/x.png)\n')

    // Assert
    expect(lines).toStrictEqual([
      "K5 README.md:3 the image https://example.com/x.png is neither a shot's capture nor a committed capture",
    ])
  })
})
