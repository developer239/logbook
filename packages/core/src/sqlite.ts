// A sync and a label batch serialise on the warehouse's lock, and OpenCode writes its database while an
// adapter reads it; wait for the lock instead of failing with SQLITE_BUSY.
const BUSY_TIMEOUT_MS = 5000

export interface ISqlStatement {
  get: (...params: (string | number | null)[]) => unknown
  all: (...params: (string | number | null)[]) => unknown[]
  run: (...params: (string | number | null)[]) => void
}

export interface ISqliteDb {
  prepare: (sql: string) => ISqlStatement
  // Runs one or more statements that take no parameters (schema, PRAGMA, BEGIN).
  exec: (sql: string) => void
  close: () => void
}

// Loaded at the first open, not at import, so that importing @log-book/core does not load SQLite for a caller that
// never opens a database. Synchronous, for a caller such as the web app whose reads are synchronous.
export const openSqliteSync = (path: string, options: { readonly isReadOnly: boolean }): ISqliteDb => {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(path, { readOnly: options.isReadOnly, timeout: BUSY_TIMEOUT_MS })
  return {
    prepare: (sql) => {
      const statement = db.prepare(sql)
      return {
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
        run: (...params) => {
          statement.run(...params)
        },
      }
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  }
}

// The same open, its failure a rejection.
export const openSqlite = async (path: string, options: { readonly isReadOnly: boolean }): Promise<ISqliteDb> =>
  Promise.resolve().then(() => openSqliteSync(path, options))
