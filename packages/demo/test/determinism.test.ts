import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { openSqlite } from '@log-book/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDemo } from '../src/build/build-demo.js'
import { canonicalDump } from '../src/write/canonical-dump.js'
import { isSqlite } from '../src/write/write-demo.js'

const BIN = fileURLToPath(new URL('../bin/logbook-demo.mjs', import.meta.url))
const WEEK_MS = 7 * 24 * 3_600_000
// Later than any count the plan holds and earlier than any of its times.
const FIRST_TIME = Date.UTC(2000, 0, 1)
const BUILD_TIMEOUT_MS = 300_000

const run = promisify(execFile)
const directories: string[] = []

const temporary = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'demo-determinism-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

// A build of the small set through `logbook-demo build`, in a child process started in the given zone.
const buildIn = async (zone: string, out: string): Promise<void> => {
  await run(process.execPath, [BIN, 'build', '--out', out], { env: { ...process.env, TZ: zone } })
}

const homeFiles = async (out: string): Promise<string[]> =>
  (await readdir(join(out, 'home'), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(out, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .toSorted()

// What a file holds for comparison: a SQLite database by its canonical dump, any other file by its bytes.
const contentOf = async (path: string): Promise<string> =>
  (await isSqlite(path)) ? canonicalDump(path, 'sqlite') : (await readFile(path)).toString('base64')

// The adapters read a transcript's and a database's modification time; a command file is read by its text only.
const isTimeRead = (path: string): boolean => !path.includes('/commands/')

// The table a line of a canonical dump belongs to: the one whose CREATE statement comes last before it.
const tableAt = (lines: readonly string[], index: number): string =>
  /CREATE TABLE "?(?<name>\w+)/u.exec(
    lines.slice(0, index + 1).findLast((line) => line.startsWith('CREATE TABLE')) ?? ''
  )?.groups?.name ?? 'user_version'

const firstDumpDifference = (left: string, right: string): string | null => {
  const [leftLines, rightLines] = [left.split('\n'), right.split('\n')]
  const index = leftLines.findIndex((line, at) => line !== rightLines[at])
  if (index === -1) {
    return leftLines.length === rightLines.length ? null : `table ${tableAt(leftLines, leftLines.length - 1)}`
  }
  return `table ${tableAt(leftLines, index)}`
}

const fingerprints = async (out: string): Promise<string[]> => {
  const db = await openSqlite(join(out, 'warehouse.db'), { isReadOnly: true })
  try {
    return (
      db
        .prepare('SELECT harness, locator, fingerprint FROM source_state ORDER BY harness, locator')
        .all() as unknown as { fingerprint: string }[]
    ).map((row) => row.fingerprint)
  } finally {
    db.close()
  }
}

// The first file, table or column where two builds differ, or null when they are the same build.
const firstDifference = async (left: string, right: string): Promise<string | null> => {
  const records = await Promise.all(
    ['manifest.json', 'plan.json'].map(async (file) =>
      (await readFile(join(left, file))).equals(await readFile(join(right, file))) ? null : file
    )
  )
  const record = records.find((file) => file !== null)
  if (record !== undefined) {
    return record
  }
  const [leftFiles, rightFiles] = await Promise.all([homeFiles(left), homeFiles(right)])
  if (leftFiles.join('\n') !== rightFiles.join('\n')) {
    return 'home file list'
  }
  const files = await Promise.all(
    leftFiles.map(async (file) => {
      const [leftPath, rightPath] = [join(left, file), join(right, file)]
      const [leftStat, rightStat] = await Promise.all([stat(leftPath), stat(rightPath)])
      if ((await contentOf(leftPath)) !== (await contentOf(rightPath))) {
        return file
      }
      return isTimeRead(file) && leftStat.mtimeMs !== rightStat.mtimeMs ? `${file} modification time` : null
    })
  )
  const differing = files.find((file) => file !== null)
  if (differing !== undefined) {
    return differing
  }
  if ((await fingerprints(left)).join('\n') !== (await fingerprints(right)).join('\n')) {
    return 'source_state.fingerprint'
  }
  return firstDumpDifference(
    await canonicalDump(join(left, 'warehouse.db'), 'warehouse'),
    await canonicalDump(join(right, 'warehouse.db'), 'warehouse')
  )
}

// Every leaf where the second plan is not the first moved by a week: a time must move by exactly a week, anything else
// must stay.
const unmoved = (left: unknown, right: unknown, path: string): string[] => {
  if (typeof left === 'number' && typeof right === 'number') {
    const moved = left >= FIRST_TIME ? right - left === WEEK_MS : right === left
    return moved ? [] : [path]
  }
  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
    return keys.flatMap((key) =>
      unmoved((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], `${path}.${key}`)
    )
  }
  return left === right ? [] : [path]
}

const sessionIds = async (warehouse: string): Promise<string[]> => {
  const db = await openSqlite(warehouse, { isReadOnly: true })
  try {
    return (db.prepare('SELECT id FROM session ORDER BY id').all() as unknown as { id: string }[]).map((row) => row.id)
  } finally {
    db.close()
  }
}

describe('a demo build', () => {
  it(
    'is the same build in any time zone, started at any time',
    async () => {
      // Arrange
      const directory = await temporary()
      const [first, second] = [join(directory, 'auckland'), join(directory, 'los-angeles')]

      // Act
      await buildIn('Pacific/Auckland', first)
      await sleep(1100)
      await buildIn('America/Los_Angeles', second)

      // Assert
      expect(await firstDifference(first, second)).toBeNull()
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'moves every time and nothing else when its anchor moves by a week',
    async () => {
      // Arrange
      vi.stubEnv('TZ', 'UTC')
      const directory = await temporary()
      const first = await buildDemo({ size: 'small', out: join(directory, 'first') })

      // Act
      const second = await buildDemo({
        size: 'small',
        anchor: first.plan.plan.anchor + WEEK_MS,
        out: join(directory, 'second'),
      })

      // Assert
      expect({
        ids: second.plan.ids,
        sessions: await sessionIds(second.warehouse),
        unmoved: unmoved(first.plan, second.plan, 'plan'),
      }).toStrictEqual({
        ids: first.plan.ids,
        sessions: await sessionIds(first.warehouse),
        unmoved: [],
      })
    },
    BUILD_TIMEOUT_MS
  )
})
