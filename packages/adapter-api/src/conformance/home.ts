import { createHash } from 'node:crypto'
import { cp, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { IFixtureSet } from './fixture-set.js'

export const expectedDirectory = (fixture: IFixtureSet): string => join(fixture.root, 'expected')

const withTemporaryDirectory = async <TResult>(work: (directory: string) => Promise<TResult>): Promise<TResult> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-conformance-')))
  try {
    return await work(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const copyTree = async (fixture: IFixtureSet, home: string): Promise<void> => {
  const expected = expectedDirectory(fixture)
  await cp(fixture.root, home, { recursive: true, filter: (source) => source !== expected })
}

// Runs one case on a fresh copy of the fixture tree, prepared and deleted afterwards, so no case can change a
// committed fixture.
export const withFixtureHome = async <TResult>(
  fixture: IFixtureSet,
  work: (home: string) => Promise<TResult>
): Promise<TResult> =>
  withTemporaryDirectory(async (home) => {
    await copyTree(fixture, home)
    await fixture.prepare(home)
    return work(home)
  })

// As withFixtureHome, with the database built live and its writer connection open while the work runs.
export const withLiveHome = async <TResult>(
  fixture: IFixtureSet,
  prepareLive: (home: string) => Promise<() => void>,
  work: (home: string) => Promise<TResult>
): Promise<TResult> =>
  withTemporaryDirectory(async (home) => {
    await copyTree(fixture, home)
    const closeWriter = await prepareLive(home)
    try {
      return await work(home)
    } finally {
      closeWriter()
    }
  })

export const hashFile = async (path: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

export const withEmptyHome = async <TResult>(work: (home: string) => Promise<TResult>): Promise<TResult> =>
  withTemporaryDirectory(work)

// Every file and directory under the home with a hash of each file's bytes, `-wal` and `-shm` files included.
export const hashTree = async (home: string): Promise<Record<string, string>> => {
  const entries = await readdir(home, { recursive: true, withFileTypes: true })
  const hashed = await Promise.all(
    entries.map(async (entry): Promise<[string, string]> => {
      const path = join(entry.parentPath, entry.name)
      const hash = entry.isFile() ? await hashFile(path) : 'not a file'
      return [relative(home, path), hash]
    })
  )
  return Object.fromEntries(hashed.toSorted(([left], [right]) => (left < right ? -1 : 1)))
}
