import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkK1 } from './k1.js'
import { findingLine } from './k7.js'

const COMMITTED = 'apps/docs/src/public/committed'
const directories: string[] = []

// A repository whose documentation package holds the committed capture manifest with these entries, and these files.
const linesFor = async (entries: readonly string[], files: readonly string[]): Promise<string[]> => {
  const repository = await mkdtemp(join(tmpdir(), 'docs-k1-'))
  directories.push(repository)
  const manifest = {
    captures: entries.map((file) => ({ file, sha256: createHash('sha256').update(file).digest('hex') })),
  }
  await Promise.all(
    [
      ['apps/docs/committed-captures.json', `${JSON.stringify(manifest, null, 2)}\n`],
      ...files.map((file) => [file, 'invented bytes']),
    ].map(async ([file = '', text = '']) => {
      await mkdir(dirname(join(repository, file)), { recursive: true })
      await writeFile(join(repository, file), text)
    })
  )
  return (await checkK1({ docs: join(repository, 'apps', 'docs'), repository })).map(findingLine)
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('checkK1', () => {
  it('passes committed captures that are entries, under committed/', async () => {
    // Act
    const lines = await linesFor([`${COMMITTED}/dashboard.png`], [`${COMMITTED}/dashboard.png`])

    // Assert
    expect(lines).toStrictEqual([])
  })

  it('fails an entry naming a file outside committed/, at its line', async () => {
    // Act
    const lines = await linesFor(['apps/docs/src/public/dashboard.png'], [])

    // Assert
    expect(lines).toStrictEqual([
      'K1 apps/docs/committed-captures.json:4 apps/docs/src/public/dashboard.png is outside apps/docs/src/public/committed/',
    ])
  })

  it('fails a file under committed/ that is no entry', async () => {
    // Act
    const lines = await linesFor([], [`${COMMITTED}/example.png`])

    // Assert
    expect(lines).toStrictEqual([`K1 ${COMMITTED}/example.png:1 is not an entry of apps/docs/committed-captures.json`])
  })
})
