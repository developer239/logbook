import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkK2 } from './k2.js'
import { findingLine } from './k7.js'

const BUILT = 'apps/docs/.vitepress/dist'
const SHOT = 'invented shot bytes'
const COMMITTED = 'invented committed bytes'
const directories: string[] = []

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

// A repository with the two lists and a built site holding the run's manifest, a shot, the logo and these files.
const linesFor = async (committedSha: string, files: Readonly<Record<string, string>>): Promise<string[]> => {
  const repository = await mkdtemp(join(tmpdir(), 'docs-k2-'))
  directories.push(repository)
  const all = {
    'apps/docs/artwork.json': JSON.stringify({ files: ['apps/docs/src/public/logo.svg'] }),
    'apps/docs/committed-captures.json': JSON.stringify({
      captures: [{ file: 'apps/docs/src/public/committed/dashboard.png', sha256: committedSha }],
    }),
    [`${BUILT}/captures/manifest.json`]: JSON.stringify({
      captures: [{ file: 'dashboard-dark.png', sha256: sha256(SHOT) }],
    }),
    [`${BUILT}/captures/dashboard-dark.png`]: SHOT,
    [`${BUILT}/logo.svg`]: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    ...files,
  }
  await Promise.all(
    Object.entries(all).map(async ([file, text]) => {
      await mkdir(dirname(join(repository, file)), { recursive: true })
      await writeFile(join(repository, file), text)
    })
  )
  return (await checkK2({ docs: join(repository, 'apps', 'docs'), built: join(repository, BUILT), repository })).map(
    findingLine
  )
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('checkK2', () => {
  it('passes artwork, a capture of the manifest and a committed capture with an equal SHA-256', async () => {
    // Act
    const lines = await linesFor(sha256(COMMITTED), { [`${BUILT}/committed/dashboard.png`]: COMMITTED })

    // Assert
    expect(lines).toStrictEqual([])
  })

  it('fails a built image the capture manifest does not hold, in any letter case', async () => {
    // Act
    const lines = await linesFor(sha256(COMMITTED), { [`${BUILT}/captures/extra.PNG`]: SHOT })

    // Assert
    expect(lines).toStrictEqual([
      `K2 ${BUILT}/captures/extra.PNG:1 is not artwork, a capture of this build's manifest or a committed capture`,
    ])
  })

  it("fails a committed capture whose bytes differ from its entry's SHA-256", async () => {
    // Act
    const lines = await linesFor(sha256('other bytes'), { [`${BUILT}/committed/dashboard.png`]: COMMITTED })

    // Assert
    expect(lines).toStrictEqual([
      `K2 ${BUILT}/committed/dashboard.png:1 differs from the SHA-256 its source on record holds`,
    ])
  })
})
