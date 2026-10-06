import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findingLine } from './k7.js'
import { checkK10 } from './k10.js'

const MB = 1024 * 1024
const directories: string[] = []

// A repository whose built site holds files of these sizes.
const checkWith = async (sizes: Readonly<Record<string, number>>): Promise<{ lines: string[]; report: string[] }> => {
  const repository = await mkdtemp(join(tmpdir(), 'docs-k10-'))
  directories.push(repository)
  const built = join(repository, 'apps', 'docs', '.vitepress', 'dist')
  await Promise.all(
    Object.entries(sizes).map(async ([file, size]) => {
      await mkdir(dirname(join(built, file)), { recursive: true })
      await writeFile(join(built, file), Buffer.alloc(size))
    })
  )
  const { findings, report } = await checkK10({ built, repository })
  return { lines: findings.map(findingLine), report }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('checkK10', () => {
  it('fails a 1.1 MB PNG and reports the videos against their budgets, the largest PNG and the total', async () => {
    // Act
    const result = await checkWith({
      'captures/tour.mp4': 4 * MB,
      'captures/conversation-scroll.mp4': 2 * MB,
      'captures/big.png': 1.1 * MB,
      'index.html': MB / 2,
    })

    // Assert
    expect(result).toStrictEqual({
      lines: ['K10 apps/docs/.vitepress/dist/captures/big.png:1 is 1.1 MB, over 1 MB'],
      report: [
        'captures/tour.mp4: 4.0 MB of a 6.0 MB budget',
        'captures/conversation-scroll.mp4: 2.0 MB of a 3.0 MB budget',
        'Largest PNG: captures/big.png, 1.1 MB',
        'Site: 7.6 MB in 4 files',
      ],
    })
  })

  it('fails a video over twice its budget', async () => {
    // Act
    const { lines } = await checkWith({ 'captures/tour.mp4': 13 * MB, 'captures/conversation-scroll.mp4': MB })

    // Assert
    expect(lines).toStrictEqual(['K10 apps/docs/.vitepress/dist/captures/tour.mp4:1 is 13.0 MB, over 12.0 MB'])
  })
})
