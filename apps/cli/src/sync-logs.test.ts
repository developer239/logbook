import { mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSyncLogs, SYNC_LOG_LIMIT } from './sync-logs.js'

const OCTAL = 8
const PERMISSION_DIGITS = 3

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sync-logs-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

// A clock that moves one second per log.
const secondsFrom = (start: number): (() => Date) => {
  let at = start
  return () => {
    at += 1000
    return new Date(at)
  }
}

const writeLog = async (logs: ReturnType<typeof createSyncLogs>): Promise<string> => {
  const { path, stream } = logs.open()
  stream.end('Working out the derived facts\n')
  await finished(stream)
  return path
}

describe('createSyncLogs', () => {
  it('writes each log under logs/ in the data directory, the directory 0700 and the file 0600', async () => {
    // Arrange
    const logs = createSyncLogs(directory, () => new Date(2026, 9, 4, 14, 40, 0))

    // Act
    const path = await writeLog(logs)

    // Assert
    expect({
      path,
      directoryMode: (await stat(join(directory, 'logs'))).mode.toString(OCTAL).slice(-PERMISSION_DIGITS),
      fileMode: (await stat(path)).mode.toString(OCTAL).slice(-PERMISSION_DIGITS),
    }).toStrictEqual({
      path: join(directory, 'logs', 'sync-2026-10-04T14-40-00.log'),
      directoryMode: '700',
      fileMode: '600',
    })
  })

  it('gives a second sync started in the same second a file of its own', async () => {
    // Arrange
    const logs = createSyncLogs(directory, () => new Date(2026, 9, 4, 14, 40, 0))

    // Act
    const first = await writeLog(logs)
    const paths = [first, await writeLog(logs)]

    // Assert
    expect(paths.map((path) => path.slice(directory.length + 1))).toStrictEqual([
      'logs/sync-2026-10-04T14-40-00.log',
      'logs/sync-2026-10-04T14-40-00-2.log',
    ])
  })

  it('keeps the newest 20 of 21 logs', async () => {
    // Arrange
    const start = new Date(2026, 9, 4, 14, 0, 0).getTime()
    const logs = createSyncLogs(directory, secondsFrom(start))
    const opened = Array.from({ length: SYNC_LOG_LIMIT + 1 }, () => logs.open())
    await Promise.all(
      opened.map(async ({ path, stream }, index) => {
        stream.end('Working out the derived facts\n')
        await finished(stream)
        // Each log last written a second after the one before it.
        const at = new Date(start + index * 1000)
        await utimes(path, at, at)
      })
    )
    const paths = opened.map(({ path }) => path)

    // Act
    logs.prune()

    // Assert
    const kept = (await readdir(join(directory, 'logs'))).toSorted()
    expect(kept).toStrictEqual(
      paths
        .slice(1)
        .map((path) => path.slice(join(directory, 'logs').length + 1))
        .toSorted()
    )
  })
})
