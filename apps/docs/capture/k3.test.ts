import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findingLine } from '../scripts/k7.js'
import { checkK3 } from './k3.js'

const SMALL_SESSION = 'claude-code:de30da7a-0000-4000-8000-000000000001'
const OTHER_UUID = '0b6d1f2e-9a4c-4e1b-8f3d-2c7a5e9b1d04'
const directories: string[] = []

// A repository whose built site holds one text capture of the small set, and the run's manifest.
const capturesWith = async (text: string): Promise<{ repository: string; captures: string }> => {
  const repository = await mkdtemp(join(tmpdir(), 'docs-k3-'))
  directories.push(repository)
  const captures = join(repository, 'apps', 'docs', '.vitepress', 'dist', 'captures')
  await mkdir(captures, { recursive: true })
  const manifest = {
    demo: [{ build: 'not-labelled', size: 'small', seed: 1, labels: 'none', anchor: '2026-09-28T18:00:00.000Z' }],
    captures: [
      { file: 'tokens-dark.png', shot: 'tokens', scheme: 'dark', build: 'not-labelled', text: 'tokens-dark.txt' },
    ],
  }
  await Promise.all([
    writeFile(join(captures, 'manifest.json'), JSON.stringify(manifest)),
    writeFile(join(captures, 'tokens-dark.txt'), text),
  ])
  return { repository, captures }
}

const linesOf = async (text: string): Promise<string[]> => {
  const { repository, captures } = await capturesWith(text)
  return (await checkK3({ captures, repository })).map(findingLine)
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('checkK3', () => {
  it('refuses a UUID outside the demo shape with C5 at its line, without the text it found', async () => {
    // Act
    const lines = await linesOf(`Tokens by tool\n/conversations/${OTHER_UUID}\n`)

    // Assert
    expect({ lines, holdsText: lines.some((line) => line.includes(OTHER_UUID)) }).toStrictEqual({
      lines: ['K3 apps/docs/.vitepress/dist/captures/tokens-dark.txt:2 C5'],
      holdsText: false,
    })
  })

  it("refuses the checking machine's home path with C4, without the text it found", async () => {
    // Act
    const lines = await linesOf(`Tokens by tool\nRead ${homedir()}/notes.md\n`)

    // Assert
    expect({ lines, holdsText: lines.some((line) => line.includes(homedir())) }).toStrictEqual({
      // An absolute path outside /home/example is outside the invented shapes too.
      lines: [
        'K3 apps/docs/.vitepress/dist/captures/tokens-dark.txt:2 C4',
        'K3 apps/docs/.vitepress/dist/captures/tokens-dark.txt:2 C5',
      ],
      holdsText: false,
    })
  })

  it("passes a capture holding only the small set's session ids", async () => {
    // Act
    const lines = await linesOf(
      `Conversations\n/conversations/${encodeURIComponent(SMALL_SESSION)}\n${SMALL_SESSION}\n`
    )

    // Assert
    expect(lines).toStrictEqual([])
  })
})
