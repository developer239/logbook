import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { versionAt } from './version.js'

const run = promisify(execFile)
// An invented author, and no signing, whatever the machine's own git settings.
const GIT_SETTINGS = [
  '-c',
  'user.name=Example',
  '-c',
  'user.email=dev@example.com',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
]
const directories: string[] = []

const git = async (directory: string, args: readonly string[]): Promise<void> => {
  await run('git', [...GIT_SETTINGS, ...args], {
    cwd: directory,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
}

// A repository with one commit.
const repository = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'docs-version-'))
  directories.push(directory)
  await git(directory, ['init', '-q'])
  await git(directory, ['commit', '-q', '--allow-empty', '-m', 'first'])
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('versionAt', () => {
  it('names the tag at a tagged commit', async () => {
    // Arrange
    const directory = await repository()
    await git(directory, ['tag', 'v9.9.9'])

    // Act
    const version = await versionAt(directory)

    // Assert
    expect(version).toBe('v9.9.9')
  })

  it('names main at an untagged commit', async () => {
    // Arrange
    const directory = await repository()

    // Act
    const version = await versionAt(directory)

    // Assert
    expect(version).toBe('main')
  })
})
