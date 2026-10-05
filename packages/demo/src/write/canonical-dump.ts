import { openSqlite, type ISqliteDb } from '@log-book/core'
import { RULES_LABELLER } from '@log-book/warehouse'

// `warehouse` leaves out what a sync fills from the wall clock or the file system's listing order; `sqlite` keeps every
// table and column.
export type DumpKind = 'warehouse' | 'sqlite'

interface IColumn {
  name: string
  pk: number
}

interface ITableRules {
  // Columns left out of every row.
  omitted: readonly string[]
  // A column left out of the rows a condition selects, as SQL on the row.
  omittedWhere: readonly (readonly [string, string])[]
  // The order of the rows, in place of the primary key.
  order: readonly string[] | null
}

const NO_RULES: ITableRules = { omitted: [], omittedWhere: [], order: null }

// The warehouse's own exceptions: an index derived from `part`, `part.rowid`, which follows the order units are listed
// in, and the columns a sync stamps with the time it ran.
const WAREHOUSE_RULES: Readonly<Record<string, ITableRules>> = {
  harness: { ...NO_RULES, omitted: ['checked_at'] },
  source_state: { ...NO_RULES, omitted: ['imported_at'] },
  sync_run: { ...NO_RULES, omitted: ['started_at', 'ended_at'] },
  part: { ...NO_RULES, omitted: ['rowid'], order: ['message_id', 'idx'] },
  label: { ...NO_RULES, omittedWhere: [['labelled_at', `labeller = '${RULES_LABELLER}'`]] },
}
const DERIVED_TABLE = /^part_fts(?:_|$)/u

const isDumped = (kind: DumpKind, table: string): boolean => kind === 'sqlite' || !DERIVED_TABLE.test(table)

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`

// A blob as its bytes in hex, so a row reads back the same as JSON on any machine.
const valueOf = (value: unknown): unknown =>
  value instanceof Uint8Array ? { blob: Buffer.from(value).toString('hex') } : value

const tableDump = (db: ISqliteDb, table: string, sql: string, rules: ITableRules): string[] => {
  const columns = (db.prepare(`PRAGMA table_info(${quoted(table)})`).all() as unknown as IColumn[]).filter(
    (column) => !rules.omitted.includes(column.name)
  )
  const keys = columns.filter((column) => column.pk > 0).toSorted((left, right) => left.pk - right.pk)
  const order =
    rules.order ?? (keys.length > 0 ? keys.map((column) => column.name) : columns.map((column) => column.name))
  const selected = columns.map((column) => {
    const condition = rules.omittedWhere.find(([name]) => name === column.name)?.[1]
    return condition === undefined
      ? quoted(column.name)
      : `CASE WHEN ${condition} THEN NULL ELSE ${quoted(column.name)} END`
  })
  const rows = db
    .prepare(`SELECT ${selected.join(', ')} FROM ${quoted(table)} ORDER BY ${order.map(quoted).join(', ')}`)
    .all() as unknown as Record<string, unknown>[]
  return [sql, ...rows.map((row) => JSON.stringify(Object.values(row).map(valueOf)))]
}

// The form a SQLite database is compared in: `PRAGMA user_version`, then each table's CREATE statement as
// sqlite_schema stores it, then its rows as JSON, one per line, sorted by primary key, or by every column for a table
// without one. Bytes are no contract: SQLite writes its library version into the header and lays out pages freely.
export const canonicalDump = async (path: string, kind: DumpKind): Promise<string> => {
  const db = await openSqlite(path, { isReadOnly: true })
  try {
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const tables = (
      db
        .prepare(
          "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
        )
        .all() as unknown as { name: string; sql: string }[]
    ).filter((table) => isDumped(kind, table.name))
    const lines = tables.flatMap(({ name, sql }) =>
      tableDump(db, name, sql, kind === 'warehouse' ? (WAREHOUSE_RULES[name] ?? NO_RULES) : NO_RULES)
    )
    return [String(version), ...lines].join('\n')
  } finally {
    db.close()
  }
}
