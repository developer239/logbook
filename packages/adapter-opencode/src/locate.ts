import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { IAdapterEnvironment, LocateResult } from '@log-book/adapter-api'
import { isErrnoCode } from '@log-book/core'

export const DATABASE_VARIABLE = 'OPENCODE_DB'
export const DISABLE_CHANNEL_DATABASE_VARIABLE = 'OPENCODE_DISABLE_CHANNEL_DB'
export const DATA_HOME_VARIABLE = 'XDG_DATA_HOME'

const RELEASE_DATABASE = 'opencode.db'
const IN_MEMORY = ':memory:'
const CHANNEL_DATABASE_DISABLED = new Set(['1', 'true'])
// opencode.db, or opencode-<channel>.db with the channel's characters outside A-Z a-z 0-9 . _ - replaced by -.
const DATABASE_NAME = /^opencode(?:-[A-Za-z0-9._-]+)?\.db$/u

interface ICandidate {
  name: string
  writtenAt: number
}

// The path with the home directory shown as `~`.
const withHomeAsTilde = (path: string, homeDir: string): string => {
  if (path === homeDir) {
    return '~'
  }
  return path.startsWith(`${homeDir}${sep}`) ? `~${path.slice(homeDir.length)}` : path
}

// $XDG_DATA_HOME/opencode when XDG_DATA_HOME is absolute; a relative or empty value is ignored, as the XDG
// specification requires.
const resolveDataDir = (env: IAdapterEnvironment): string => {
  const dataHome = env.variables[DATA_HOME_VARIABLE]
  const base = dataHome !== undefined && isAbsolute(dataHome) ? dataHome : join(env.homeDir, '.local', 'share')
  return join(base, 'opencode')
}

const modifiedAt = async (path: string): Promise<number | null> => {
  try {
    return (await stat(path)).mtimeMs
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT')) {
      return null
    }
    throw error
  }
}

const isRegularFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile()
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      return false
    }
    throw error
  }
}

// The databases OpenCode's naming rule could have produced in the data directory, by entry name and kind only.
const listCandidates = async (dataDir: string): Promise<ICandidate[]> => {
  let entries: string[] = []
  try {
    entries = (await readdir(dataDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && DATABASE_NAME.test(entry.name))
      .map((entry) => entry.name)
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      return []
    }
    throw error
  }
  // In WAL mode writes land in the -wal until a checkpoint, so a database was written at the newer of the two times.
  return Promise.all(
    entries.map(async (name) => {
      const path = join(dataDir, name)
      const [file, wal] = await Promise.all([modifiedAt(path), modifiedAt(`${path}-wal`)])
      return { name, writtenAt: Math.max(file ?? 0, wal ?? 0) }
    })
  )
}

// The written most recently; a tie goes to the name that sorts first.
const newest = (candidates: readonly ICandidate[]): ICandidate | undefined =>
  candidates.toSorted((left, right) => {
    if (left.writtenAt !== right.writtenAt) {
      return right.writtenAt - left.writtenAt
    }
    return left.name < right.name ? -1 : Number(left.name > right.name)
  })[0]

const chooseDatabase = async (
  env: IAdapterEnvironment,
  dataDir: string
): Promise<{ path: string | null; count: number }> => {
  const configured = env.variables[DATABASE_VARIABLE]
  if (configured !== undefined && configured !== '') {
    if (configured === IN_MEMORY) {
      return { path: null, count: 1 }
    }
    return { path: isAbsolute(configured) ? configured : resolve(dataDir, configured), count: 1 }
  }
  if (CHANNEL_DATABASE_DISABLED.has(env.variables[DISABLE_CHANNEL_DATABASE_VARIABLE] ?? '')) {
    return { path: join(dataDir, RELEASE_DATABASE), count: 1 }
  }
  const candidates = await listCandidates(dataDir)
  const chosen = newest(candidates)
  return { path: join(dataDir, chosen?.name ?? RELEASE_DATABASE), count: candidates.length }
}

// Finds OpenCode's database the way OpenCode 2.0 names it, without running OpenCode: OPENCODE_DB when set (:memory:
// keeps no database), opencode.db when the channel database is disabled, and otherwise the newest of the databases its
// channel rule could have produced. Reads entry names, kinds and modification times only.
export const locateDatabase = async (env: IAdapterEnvironment): Promise<LocateResult> => {
  const dataDir = resolveDataDir(env)
  const { path, count } = await chooseDatabase(env, dataDir)
  if (path === null) {
    return { kind: 'not-found', lookedAt: null }
  }
  if (!(await isRegularFile(path))) {
    return { kind: 'not-found', lookedAt: path }
  }
  const choice = count > 1 ? ` (newest of ${String(count)} databases; set ${DATABASE_VARIABLE} to choose)` : ''
  return {
    kind: 'found',
    location: { root: path, kind: 'file', describe: `${withHomeAsTilde(path, env.homeDir)}${choice}` },
  }
}
