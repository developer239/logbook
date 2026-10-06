import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkK4 } from './k4.js'
import { findingLine } from './k7.js'

const SITE_URL = 'https://developer239.github.io/logbook/'
const SHOT_LIST =
  "export const SHOTS = [\n  shot({\n    id: 'dashboard',\n  }),\n  shot({\n    id: 'tokens',\n  }),\n]\n"
const directories: string[] = []

// A repository with the shot list, a README and a built site of these pages.
const linesFor = async (pages: Readonly<Record<string, string>>, readme: string): Promise<string[]> => {
  const repository = await mkdtemp(join(tmpdir(), 'docs-k4-'))
  directories.push(repository)
  const built = join(repository, 'apps', 'docs', '.vitepress', 'dist')
  const files = {
    [join(repository, 'apps', 'docs', 'capture', 'shots.ts')]: SHOT_LIST,
    [join(repository, 'README.md')]: readme,
    ...Object.fromEntries(Object.entries(pages).map(([page, html]) => [join(built, page), html])),
  }
  await Promise.all(
    Object.entries(files).map(async ([file, text]) => {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, text)
    })
  )
  return (
    await checkK4({
      built,
      readme: join(repository, 'README.md'),
      shotList: join(repository, 'apps', 'docs', 'capture', 'shots.ts'),
      repository,
      shots: ['dashboard', 'tokens'],
    })
  ).map(findingLine)
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('checkK4', () => {
  it('fails a shot no page shows, naming it at its line of the shot list', async () => {
    // Act
    const lines = await linesFor({ 'index.html': '<img src="/logbook/captures/dashboard-dark.png">' }, '# Log Book\n')

    // Assert
    expect(lines).toStrictEqual([
      'K4 apps/docs/capture/shots.ts:6 the shot tokens is shown by no page and not in the README',
    ])
  })

  it('passes a shot shown only as a README image', async () => {
    // Act
    const lines = await linesFor(
      { 'ui/dashboard.html': '<meta property="og:image" content="/logbook/captures/dashboard-light.png">' },
      `![Tokens](${SITE_URL}captures/tokens-dark.png)\n`
    )

    // Assert
    expect(lines).toStrictEqual([])
  })
})
