import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IAdapterContext } from '@log-book/adapter-api'
import { openSqlite } from '@log-book/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeCode } from './adapter.js'

const isRoot = process.getuid?.() === 0

const context = (): IAdapterContext => ({
  signal: new AbortController().signal,
  onProgress: () => undefined,
  openSqlite,
})

describe('claudeCode', () => {
  let projects = ''

  beforeEach(async () => {
    projects = join(await realpath(await mkdtemp(join(tmpdir(), 'log-book-claude-adapter-'))), 'projects')
    await mkdir(projects)
  })

  afterEach(async () => {
    await chmod(projects, 0o700)
    await rm(join(projects, '..'), { recursive: true, force: true })
  })

  it('describes Claude Code', () => {
    // Arrange
    const adapter = claudeCode()

    // Act
    const { descriptor } = adapter

    // Assert
    expect(descriptor).toStrictEqual({
      id: 'claude-code',
      name: 'Claude Code',
      defaultAgent: 'Claude',
      unitNoun: 'transcripts',
      filterAlias: 'claude',
      parserVersion: 2,
      testedVersions: ['2.1'],
      locationVariables: ['CLAUDE_CONFIG_DIR'],
    })
  })

  it('opens a reader with no format drift whose close does nothing', async () => {
    // Arrange
    const location = { root: projects, kind: 'directory' as const, describe: projects }

    // Act
    const reader = await claudeCode().openSource(location, context())
    const units = await reader.listUnits()

    // Assert
    expect({ formatDrift: reader.formatDrift, units }).toStrictEqual({ formatDrift: null, units: [] })
    await expect(reader.close()).resolves.toBeUndefined()
  })

  it.skipIf(isRoot)('refuses a projects directory it cannot list', async () => {
    // Arrange
    await chmod(projects, 0o000)
    const location = { root: projects, kind: 'directory' as const, describe: projects }

    // Act
    const opening = claudeCode().openSource(location, context())

    // Assert
    await expect(opening).rejects.toThrow(
      expect.objectContaining({
        code: 'ADAPTER_SOURCE_UNREADABLE',
        message: expect.stringContaining(`Cannot list ${projects}: `) as string,
      })
    )
  })
})
