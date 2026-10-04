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

// Imported lazily so that importing @log-book/core does not load SQLite for a caller that never opens a database.
export const openSqlite = async (path: string, options: { readonly isReadOnly: boolean }): Promise<ISqliteDb> => {
  const sqliteModule = await import('node:sqlite')
  const db = new sqliteModule.DatabaseSync(path, { readOnly: options.isReadOnly, timeout: BUSY_TIMEOUT_MS })
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
