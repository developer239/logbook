import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IAdapterEnvironment } from '@log-book/adapter-api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { locateProjects } from './locate.js'

describe('locateProjects', () => {
  let home = ''

  const environment = (variables: Record<string, string>, cwd = home): IAdapterEnvironment => ({
    variables,
    homeDir: home,
    cwd,
    platform: 'darwin',
  })

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'log-book-claude-home-')))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('finds ~/.claude/projects with no variable set', async () => {
    // Arrange
    await mkdir(join(home, '.claude', 'projects'), { recursive: true })

    // Act
    const result = await locateProjects(environment({}))

    // Assert
    expect(result).toStrictEqual({
      kind: 'found',
      location: { root: join(home, '.claude', 'projects'), kind: 'directory', describe: '~/.claude/projects' },
    })
  })

  it('finds the projects of an absolute CLAUDE_CONFIG_DIR', async () => {
    // Arrange
    const configDir = join(home, 'config', 'claude')
    await mkdir(join(configDir, 'projects'), { recursive: true })

    // Act
    const result = await locateProjects(environment({ CLAUDE_CONFIG_DIR: configDir }))

    // Assert
    expect(result).toStrictEqual({
      kind: 'found',
      location: { root: join(configDir, 'projects'), kind: 'directory', describe: '~/config/claude/projects' },
    })
  })

  it('looks at the projects of an absolute CLAUDE_CONFIG_DIR that has none', async () => {
    // Arrange
    const configDir = join(home, 'config', 'claude')
    await mkdir(configDir, { recursive: true })

    // Act
    const result = await locateProjects(environment({ CLAUDE_CONFIG_DIR: configDir }))

    // Assert
    expect(result).toStrictEqual({ kind: 'not-found', lookedAt: join(configDir, 'projects') })
  })

  it('treats an empty CLAUDE_CONFIG_DIR as unset', async () => {
    // Arrange
    await mkdir(join(home, '.claude', 'projects'), { recursive: true })

    // Act
    const result = await locateProjects(environment({ CLAUDE_CONFIG_DIR: '' }))

    // Assert
    expect(result).toStrictEqual({
      kind: 'found',
      location: { root: join(home, '.claude', 'projects'), kind: 'directory', describe: '~/.claude/projects' },
    })
  })

  it('resolves a relative CLAUDE_CONFIG_DIR against the working directory', async () => {
    // Arrange
    const cwd = join(home, 'work')
    await mkdir(join(cwd, 'settings', 'projects'), { recursive: true })

    // Act
    const result = await locateProjects(environment({ CLAUDE_CONFIG_DIR: 'settings' }, cwd))

    // Assert
    expect(result).toStrictEqual({
      kind: 'found',
      location: { root: join(cwd, 'settings', 'projects'), kind: 'directory', describe: '~/work/settings/projects' },
    })
  })

  it('looks at a projects path that is a file', async () => {
    // Arrange
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude', 'projects'), '')

    // Act
    const result = await locateProjects(environment({}))

    // Assert
    expect(result).toStrictEqual({ kind: 'not-found', lookedAt: join(home, '.claude', 'projects') })
  })
})
