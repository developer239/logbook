import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { LogBookError, openSqlite, type ISqliteDb } from '@log-book/core'
import { WAREHOUSE_ERROR_CODES, WarehouseVersionError } from './errors.js'
import { applyMigrations, readUserVersion, SCHEMA_VERSION } from './migrations.js'
import { resolveDataDirectory } from './paths.js'

// The warehouse holds whole conversations, and so do its write-ahead log and shared-memory files until a checkpoint:
// readable by the owner only.
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
// Truncates the write-ahead log after a checkpoint, so one large unit does not leave a log of hundreds of megabytes
// behind while a reader holds a snapshot.
const JOURNAL_SIZE_LIMIT_BYTES = 67_108_864

type TSqlParam = string | number | null

const SQLITE_BUSY = 5
const WAL_SWITCH_ATTEMPTS = 50
const WAL_SWITCH_RETRY_MS = 100

// What a reader of the warehouse may do: read rows as plain objects, and close.
export interface IWarehouseReader {
  all: <TRow>(sql: string, ...params: TSqlParam[]) => TRow[]
  get: <TRow>(sql: string, ...params: TSqlParam[]) => TRow | undefined
  close: () => void
}

const isBusy = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'errcode' in error && error.errcode === SQLITE_BUSY

// Two processes switching the same file to WAL at once both hold a shared lock and want an exclusive one; to avoid a
// deadlock SQLite answers one of them SQLITE_BUSY at once instead of waiting through the busy timeout. That process
// backs off, which releases its lock, the other switches the file, and the retry finds it in WAL mode already.
const switchToWal = async (db: ISqliteDb, attemptsLeft: number = WAL_SWITCH_ATTEMPTS): Promise<void> => {
  try {
    db.exec('PRAGMA journal_mode = WAL')
  } catch (error: unknown) {
    if (!isBusy(error) || attemptsLeft <= 1) {
      throw error
    }
    await delay(WAL_SWITCH_RETRY_MS)
    await switchToWal(db, attemptsLeft - 1)
  }
}

const isInside = (parent: string, child: string): boolean => {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

// The directory is Log Book's own when it created it or when it lies inside the data directory; a directory of the
// user's that a LOGBOOK_DB override points into keeps its mode.
const tightenModes = (path: string, isDirectoryOwned: boolean): void => {
  if (isDirectoryOwned) {
    chmodSync(dirname(path), DIRECTORY_MODE)
  }
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) {
      chmodSync(file, FILE_MODE)
    }
  }
}

// The warehouse database. open() is the only way to write it; every write goes through a typed method, and the store
// never reads the clock: every time it writes comes from its caller.
export class WarehouseStore implements IWarehouseReader {
  // The version the file had when it was opened, and the version it has now.
  public readonly previousVersion: number
  public readonly version: number
  private readonly db: ISqliteDb

  private constructor(db: ISqliteDb, previousVersion: number, version: number) {
    this.db = db
    this.previousVersion = previousVersion
    this.version = version
  }

  // Creates a missing directory and file, refuses a newer warehouse before changing a byte, and migrates an older one.
  public static readonly open = async (path: string): Promise<WarehouseStore> => {
    const directory = dirname(path)
    const isDirectoryNew = !existsSync(directory)
    if (isDirectoryNew) {
      mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
    }
    const db = await openSqlite(path, { isReadOnly: false })
    const previousVersion = readUserVersion(db)
    if (previousVersion > SCHEMA_VERSION) {
      db.close()
      throw new WarehouseVersionError(
        `The warehouse ${path} is at version ${String(previousVersion)}, newer than this build's ${String(SCHEMA_VERSION)}.`,
        WAREHOUSE_ERROR_CODES.WAREHOUSE_SCHEMA_NEWER,
        previousVersion,
        SCHEMA_VERSION
      )
    }
    const isDirectoryOwned = isDirectoryNew || isInside(resolveDataDirectory(), directory)
    // Before the write-ahead log exists, so SQLite creates its files with the warehouse's mode.
    tightenModes(path, isDirectoryOwned)
    await switchToWal(db)
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec(`PRAGMA journal_size_limit = ${String(JOURNAL_SIZE_LIMIT_BYTES)}`)
    applyMigrations(db)
    tightenModes(path, isDirectoryOwned)
    return new WarehouseStore(db, previousVersion, SCHEMA_VERSION)
  }

  // Opens for reading only, and only a warehouse at this build's version: under the host, the host has migrated it
  // before a reader opens it. A reader re-checks the version per request, because a newer build can migrate the file.
  public static readonly openReadOnly = async (path: string): Promise<IWarehouseReader> => {
    if (!existsSync(path)) {
      throw new LogBookError(`No warehouse at ${path}.`, WAREHOUSE_ERROR_CODES.WAREHOUSE_NOT_FOUND)
    }
    const db = await openSqlite(path, { isReadOnly: true })
    const version = readUserVersion(db)
    if (version !== SCHEMA_VERSION) {
      db.close()
      throw new WarehouseVersionError(
        `The warehouse ${path} is at version ${String(version)}; this build reads version ${String(SCHEMA_VERSION)}.`,
        WAREHOUSE_ERROR_CODES.WAREHOUSE_SCHEMA_MISMATCH,
        version,
        SCHEMA_VERSION
      )
    }
    return new WarehouseStore(db, version, version)
  }

  // node:sqlite returns rows without a prototype; readers get plain objects.
  public readonly all = <TRow>(sql: string, ...params: TSqlParam[]): TRow[] =>
    this.db
      .prepare(sql)
      .all(...params)
      .map((row) => ({ ...(row as object) }) as TRow)

  public readonly get = <TRow>(sql: string, ...params: TSqlParam[]): TRow | undefined => {
    const row = this.db.prepare(sql).get(...params)
    return row === undefined ? undefined : ({ ...(row as object) } as TRow)
  }

  public readonly close = (): void => this.db.close()
}
