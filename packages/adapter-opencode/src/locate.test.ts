import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IAdapterEnvironment, LocateResult } from '@log-book/adapter-api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { locateDatabase } from './locate.js'

const OLDER = new Date('2026-01-01T00:00:00Z')
const NEWER = new Date('2026-02-01T00:00:00Z')

const found = (root: string, describe: string): LocateResult => ({
  kind: 'found',
  location: { root, kind: 'file', describe },
})

describe('locateDatabase', () => {
  let home = ''
  let dataDir = ''

  const environment = (variables: Record<string, string> = {}): IAdapterEnvironment => ({
    variables,
    homeDir: home,
    cwd: join(home, 'work'),
    platform: 'linux',
  })

  const database = async (name: string, writtenAt = OLDER): Promise<string> => {
    const path = join(dataDir, name)
    await writeFile(path, '')
    await utimes(path, writtenAt, writtenAt)
    return path
  }

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'log-book-opencode-home-')))
    dataDir = join(home, '.local', 'share', 'opencode')
    await mkdir(dataDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('finds opencode.db alone', async () => {
    // Arrange
    const path = await database('opencode.db')

    // Act
    const result = await locateDatabase(environment())

    // Assert
    expect(result).toStrictEqual(found(path, '~/.local/share/opencode/opencode.db'))
  })

  it('finds a channel database alone', async () => {
    // Arrange
    const path = await database('opencode-local.db')

    // Act
    const result = await locateDatabase(environment())

    // Assert
    expect(result).toStrictEqual(found(path, '~/.local/share/opencode/opencode-local.db'))
  })

  it('takes the database whose write-ahead log was written last, and says it chose', async () => {
    // Arrange
    await database('opencode.db', NEWER)
    const path = await database('opencode-local.db', OLDER)
    await writeFile(`${path}-wal`, '')
    await utimes(`${path}-wal`, new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'))

    // Act
    const result = await locateDatabase(environment())

    // Assert
    expect(result).toStrictEqual(
      found(path, '~/.local/share/opencode/opencode-local.db (newest of 2 databases; set OPENCODE_DB to choose)')
    )
  })

  it('looks only at opencode.db when the channel database is disabled with 1', async () => {
    // Arrange
    await database('opencode-local.db')

    // Act
    const result = await locateDatabase(environment({ OPENCODE_DISABLE_CHANNEL_DB: '1' }))

    // Assert
    expect(result).toStrictEqual({ kind: 'not-found', lookedAt: join(dataDir, 'opencode.db') })
  })

  it('takes opencode.db over a newer channel database when the channel database is disabled with true', async () => {
    // Arrange
    const path = await database('opencode.db', OLDER)
    await database('opencode-local.db', NEWER)

    // Act
    const result = await locateDatabase(environment({ OPENCODE_DISABLE_CHANNEL_DB: 'true' }))

    // Assert
    expect(result).toStrictEqual(found(path, '~/.local/share/opencode/opencode.db'))
  })

  it('treats OPENCODE_DISABLE_CHANNEL_DB=yes as unset', async () => {
    // Arrange
    const path = await database('opencode-local.db')

    // Act
    const result = await locateDatabase(environment({ OPENCODE_DISABLE_CHANNEL_DB: 'yes' }))

    // Assert
    expect(result).toStrictEqual(found(path, '~/.local/share/opencode/opencode-local.db'))
  })

  it('does not take a migration backup', async () => {
    // Arrange
    await database('opencode.db.v1-backup.20260101')

    // Act
    const result = await locateDatabase(environment())

    // Assert
    expect(result).toStrictEqual({ kind: 'not-found', lookedAt: join(dataDir, 'opencode.db') })
  })

  it.each([
    { value: 'absolute', expected: (): string => join(home, 'elsewhere', 'chosen.db') },
    { value: 'relative', expected: (): string => join(dataDir, 'chosen.db') },
  ])('uses an $value OPENCODE_DB', async ({ value, expected }) => {
    // Arrange
    await mkdir(join(home, 'elsewhere'))
    await writeFile(expected(), '')
    const configured = value === 'absolute' ? expected() : 'chosen.db'

    // Act
    const result = await locateDatabase(environment({ OPENCODE_DB: configured }))

    // Assert
    expect(result).toStrictEqual({
      kind: 'found',
      location: { root: expected(), kind: 'file', describe: `~${expected().slice(home.length)}` },
    })
  })

  it('treats an empty OPENCODE_DB as unset', async () => {
    // Arrange
    const path = await database('opencode.db')

    // Act
    const result = await locateDatabase(environment({ OPENCODE_DB: '' }))

    // Assert
    expect(result).toStrictEqual(found(path, '~/.local/share/opencode/opencode.db'))
  })

  it('finds nothing for an in-memory OPENCODE_DB', async () => {
    // Arrange
    await database('opencode.db')

    // Act
    const result = await locateDatabase(environment({ OPENCODE_DB: ':memory:' }))

    // Assert
    expect(result).toStrictEqual({ kind: 'not-found', lookedAt: null })
  })

  it('uses an absolute XDG_DATA_HOME and ignores a relative one', async () => {
    // Arrange
    const dataHome = join(home, 'data')
    await mkdir(join(dataHome, 'opencode'), { recursive: true })
    await writeFile(join(dataHome, 'opencode', 'opencode.db'), '')
    const fallback = await database('opencode.db')

    // Act
    const results = [
      await locateDatabase(environment({ XDG_DATA_HOME: dataHome })),
      await locateDatabase(environment({ XDG_DATA_HOME: 'data' })),
    ]

    // Assert
    expect(results).toStrictEqual([
      found(join(dataHome, 'opencode', 'opencode.db'), '~/data/opencode/opencode.db'),
      found(fallback, '~/.local/share/opencode/opencode.db'),
    ])
  })

  it('takes the name that sorts first when two databases were written at the same time', async () => {
    // Arrange
    await database('opencode-local.db', OLDER)
    const path = await database('opencode-beta-1.db', OLDER)

    // Act
    const result = await locateDatabase(environment())

    // Assert
    expect(result).toStrictEqual(
      found(path, '~/.local/share/opencode/opencode-beta-1.db (newest of 2 databases; set OPENCODE_DB to choose)')
    )
  })

  it('does not take a directory named opencode.db', async () => {
    // Arrange
    await mkdir(join(dataDir, 'opencode.db'))

    // Act
    const result = await locateDatabase(environment())

    // Assert
    expect(result).toStrictEqual({ kind: 'not-found', lookedAt: join(dataDir, 'opencode.db') })
  })
})
