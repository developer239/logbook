import {
  chmodSync,
  createWriteStream,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  type WriteStream,
} from 'node:fs'
import { join } from 'node:path'

// The newest logs kept after each sync.
export const SYNC_LOG_LIMIT = 20

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const LOG_NAME = /^sync-.+\.log$/u

const twoDigits = (value: number): string => String(value).padStart(2, '0')

// The local time a log is named by: 2026-10-04T14-40-00, so the names list in the order the syncs started.
const timeOf = (at: Date): string =>
  `${String(at.getFullYear())}-${twoDigits(at.getMonth() + 1)}-${twoDigits(at.getDate())}T` +
  `${twoDigits(at.getHours())}-${twoDigits(at.getMinutes())}-${twoDigits(at.getSeconds())}`

// The full stderr of every sync the host starts, one file per sync in `<data directory>/logs`. They hold progress and
// error lines, never message text.
export interface ISyncLogs {
  // A new log for a sync starting now; a second sync in the same second gets its own file.
  open: () => { path: string; stream: WriteStream }
  // Deletes all but the newest SYNC_LOG_LIMIT.
  prune: () => void
}

export const createSyncLogs = (dataDirectory: string, now: () => Date = () => new Date()): ISyncLogs => {
  const directory = join(dataDirectory, 'logs')
  const ensureDirectory = (): void => {
    mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
    chmodSync(directory, DIRECTORY_MODE)
  }
  return {
    open: () => {
      ensureDirectory()
      const time = timeOf(now())
      const names = new Set(readdirSync(directory))
      let name = `sync-${time}.log`
      for (let copy = 2; names.has(name); copy += 1) {
        name = `sync-${time}-${String(copy)}.log`
      }
      const path = join(directory, name)
      // Created now, so the next sync to start sees the name taken.
      const fd = openSync(path, 'wx', FILE_MODE)
      return { path, stream: createWriteStream(path, { fd }) }
    },
    prune: () => {
      ensureDirectory()
      const logs = readdirSync(directory)
        .filter((name) => LOG_NAME.test(name))
        .map((name) => ({ path: join(directory, name), at: statSync(join(directory, name)).mtimeMs, name }))
        .toSorted((left, right) => {
          if (left.at !== right.at) {
            return right.at - left.at
          }
          return left.name < right.name ? 1 : -1
        })
      for (const log of logs.slice(SYNC_LOG_LIMIT)) {
        rmSync(log.path, { force: true })
      }
    },
  }
}
