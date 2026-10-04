import type { ISqliteDb } from '@log-book/core'
import { afterEach, describe, expect, it } from 'vitest'
import { applyMigrations, MIGRATIONS, SCHEMA_VERSION } from './migrations.js'
import { createTestWarehouse, insert, type ITestWarehouse } from './testing/index.js'

type TRow = Record<string, string | number | null>

// node:sqlite returns rows as objects without a prototype.
const row = (fields: TRow): TRow => Object.assign(Object.create(null) as TRow, fields)

const TABLES = [
  'event',
  'forgotten',
  'harness',
  'label',
  'label_run',
  'label_run_task',
  'link',
  'message',
  'part',
  'session',
  'session_command',
  'source_state',
  'sync_run',
  'tool_call',
  'turn',
]

// Each table's named indexes, then the automatic ones SQLite makes for a primary key that is not the rowid and for
// the unique key on harness.filter_alias.
const INDEXES: Record<string, string[]> = {
  event: ['event_session_idx', 'sqlite_autoindex_event_1'],
  forgotten: ['sqlite_autoindex_forgotten_1'],
  harness: ['sqlite_autoindex_harness_1', 'sqlite_autoindex_harness_2'],
  label: ['sqlite_autoindex_label_1'],
  label_run: [],
  label_run_task: ['sqlite_autoindex_label_run_task_1'],
  link: ['link_child_idx', 'link_parent_idx'],
  message: ['message_session_idx', 'sqlite_autoindex_message_1'],
  part: ['part_message_idx', 'part_session_idx', 'part_tool_call_idx'],
  session: ['session_started_idx', 'sqlite_autoindex_session_1'],
  session_command: ['session_command_session_idx'],
  source_state: ['sqlite_autoindex_source_state_1'],
  sync_run: [],
  tool_call: ['sqlite_autoindex_tool_call_1', 'tool_call_child_idx', 'tool_call_name_idx', 'tool_call_session_idx'],
  turn: ['sqlite_autoindex_turn_1', 'turn_parent_tool_call_idx', 'turn_parent_turn_idx', 'turn_session_idx'],
}

interface IColumnInfo {
  name: string
  type: string
  pk: number
}

const names = (db: ISqliteDb, sql: string, ...params: string[]): string[] =>
  (db.prepare(sql).all(...params) as { name: string }[]).map(({ name }) => name)

const userVersion = (db: ISqliteDb): number =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

const columnsOf = (db: ISqliteDb, table: string): IColumnInfo[] =>
  db.prepare('SELECT name, type, pk FROM pragma_table_info(?)').all(table) as IColumnInfo[]

const VALUE_OF_TYPE: Record<string, string | number> = { INTEGER: 1, TEXT: 'value', REAL: 1.5 }

const schemaOf = (db: ISqliteDb): Record<string, string[]> => ({
  tables: names(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'part_fts%' ORDER BY name"),
  virtualTables: names(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL%'"),
  triggers: names(db, "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name"),
  indexes: names(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name"),
})

const EXPECTED_SCHEMA = {
  tables: TABLES,
  virtualTables: ['part_fts'],
  triggers: ['part_fts_delete', 'part_fts_insert'],
  indexes: [
    'event_session_idx',
    'link_child_idx',
    'link_parent_idx',
    'message_session_idx',
    'part_message_idx',
    'part_session_idx',
    'part_tool_call_idx',
    'session_command_session_idx',
    'session_started_idx',
    'tool_call_child_idx',
    'tool_call_name_idx',
    'tool_call_session_idx',
    'turn_parent_tool_call_idx',
    'turn_parent_turn_idx',
    'turn_session_idx',
  ],
}

// Rows rule 4 carries across every migration: model labels, forgotten sessions and the labelling run records.
const SURVIVING_ROWS: Record<string, TRow[]> = {
  label: [
    {
      record_type: 'session',
      record_id: 'session-1',
      labeller: 'model-a',
      version: 2,
      name: 'goal',
      value: 'fix a failing test',
      labelled_at: 1_760_000_000_000,
    },
    {
      record_type: 'tool_call',
      record_id: 'call-1',
      labeller: 'model-a',
      version: 1,
      name: 'purpose',
      value: 'run tests',
      labelled_at: 1_760_000_100_000,
    },
  ],
  forgotten: [{ session_id: 'session-2', forgotten_at: 1_760_000_200_000 }],
  label_run: [
    {
      id: 1,
      pid: 4242,
      started_at: 1_760_000_000_000,
      ended_at: 1_760_000_300_000,
      outcome: 'ok',
      error: null,
      model: 'model-a',
    },
  ],
  label_run_task: [{ run_id: 1, task: 'session-goal', version: 2, planned: 10, done: 10 }],
}

const readSurvivingRows = (db: ISqliteDb): Record<string, TRow[]> =>
  Object.fromEntries(
    Object.keys(SURVIVING_ROWS).map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all() as TRow[],
    ])
  )

const insertSurvivingRows = (db: ISqliteDb): void => {
  for (const [table, rows] of Object.entries(SURVIVING_ROWS)) {
    for (const fields of rows) {
      insert(db, table, fields)
    }
  }
}

const expectedSurvivingRows = (): Record<string, TRow[]> =>
  Object.fromEntries(Object.entries(SURVIVING_ROWS).map(([table, rows]) => [table, rows.map(row)]))

describe('MIGRATIONS', () => {
  let warehouse: ITestWarehouse | null = null

  afterEach(async () => {
    await warehouse?.remove()
    warehouse = null
  })

  it.each([
    { where: 'a temporary file', isInMemory: false },
    { where: ':memory:', isInMemory: true },
  ])(
    'builds the 15 tables, part_fts, 2 triggers and 15 named indexes at version 1 on $where',
    async ({ isInMemory }) => {
      // Arrange
      warehouse = await createTestWarehouse({ isInMemory })

      // Act
      const schema = { ...schemaOf(warehouse.db), version: userVersion(warehouse.db) }

      // Assert
      expect(schema).toStrictEqual({ ...EXPECTED_SCHEMA, version: 1 })
    }
  )

  it('lists exactly each table named and automatic indexes', async () => {
    // Arrange
    warehouse = await createTestWarehouse()
    const { db } = warehouse

    // Act
    const indexes = Object.fromEntries(
      TABLES.map((table) => [table, names(db, 'SELECT name FROM pragma_index_list(?) ORDER BY name', table)])
    )

    // Assert
    expect(indexes).toStrictEqual(INDEXES)
  })

  it('builds an empty warehouse at version 0 that the runner brings to version 1', async () => {
    // Arrange
    warehouse = await createTestWarehouse({ version: 0 })
    const before = { ...schemaOf(warehouse.db), version: userVersion(warehouse.db) }

    // Act
    applyMigrations(warehouse.db)

    // Assert
    expect(before).toStrictEqual({ tables: [], virtualTables: [], triggers: [], indexes: [], version: 0 })
    expect({ ...schemaOf(warehouse.db), version: userVersion(warehouse.db) }).toStrictEqual({
      ...EXPECTED_SCHEMA,
      version: 1,
    })
  })

  it('leaves a warehouse already at the newest version unchanged', async () => {
    // Arrange
    warehouse = await createTestWarehouse()
    const { db } = warehouse
    insertSurvivingRows(db)
    const before = { schema: schemaOf(db), rows: readSurvivingRows(db), version: userVersion(db) }

    // Act
    applyMigrations(db)

    // Assert
    expect({ schema: schemaOf(db), rows: readSurvivingRows(db), version: userVersion(db) }).toStrictEqual(before)
  })

  it('refuses a version newer than the last migration', async () => {
    // Arrange
    warehouse = await createTestWarehouse({ version: 0 })
    const { db } = warehouse

    // Act
    const applying = (): void => applyMigrations(db, SCHEMA_VERSION + 1)

    // Assert
    expect(applying).toThrow('Schema version 2 does not exist; the newest is 1.')
    expect(userVersion(db)).toBe(0)
  })

  it('refuses a string in every INTEGER column of every table', async () => {
    // Arrange
    warehouse = await createTestWarehouse()
    const { db } = warehouse
    const integerColumns = TABLES.flatMap((table) => {
      const columns = columnsOf(db, table)
      // A single-column INTEGER PRIMARY KEY is the rowid, which reports a datatype mismatch instead.
      const isRowidKey = (pk: number): boolean => pk === 1 && columns.filter((column) => column.pk > 0).length === 1
      return columns
        .filter(({ type, pk }) => type === 'INTEGER' && !isRowidKey(pk))
        .map(({ name }) => ({ table, column: name }))
    })

    // Act
    const errors = integerColumns.map(({ table, column }) => {
      const fields = Object.fromEntries(
        columnsOf(db, table).map(({ name, type }) => [name, name === column ? 'soon' : (VALUE_OF_TYPE[type] ?? null)])
      )
      try {
        insert(db, table, fields)
        return `${table}.${column}: accepted`
      } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error)
      }
    })

    // Assert
    // link is the one table without an INTEGER column.
    expect([...new Set(integerColumns.map(({ table }) => table))]).toStrictEqual(
      TABLES.filter((table) => table !== 'link')
    )
    expect(errors).toStrictEqual(
      integerColumns.map(({ table, column }) => `cannot store TEXT value in INTEGER column ${table}.${column}`)
    )
  })

  it('finds a part by a quoted phrase until the part is deleted', async () => {
    // Arrange
    warehouse = await createTestWarehouse()
    const { db } = warehouse
    insert(db, 'part', {
      rowid: 7,
      message_id: 'm1',
      session_id: 's1',
      idx: 0,
      kind: 'text',
      text: 'the build is green',
    })
    const search = (): TRow[] =>
      db.prepare('SELECT rowid FROM part_fts WHERE part_fts MATCH \'"build is green"\'').all() as TRow[]
    const found = search()

    // Act
    db.prepare('DELETE FROM part WHERE rowid = ?').run(7)

    // Assert
    expect({ found, afterDelete: search() }).toStrictEqual({ found: [row({ rowid: 7 })], afterDelete: [] })
  })

  it('does not stem: fail does not match failed', async () => {
    // Arrange
    warehouse = await createTestWarehouse()
    const { db } = warehouse
    insert(db, 'part', { message_id: 'm1', session_id: 's1', idx: 0, kind: 'text', text: 'the test failed twice' })

    // Act
    const matches = db.prepare("SELECT rowid FROM part_fts WHERE part_fts MATCH 'fail'").all()

    // Assert
    expect(matches).toStrictEqual([])
  })
})

describe('migration survival', () => {
  // One case per migration from version 2 on: rule 4's rows, inserted at version n - 1, survive step n.
  for (const version of MIGRATIONS.keys()) {
    const step = version + 1
    if (step < 2) {
      continue
    }
    it(`keeps model labels, forgotten sessions and labelling run records across step ${String(step)}`, async () => {
      // Arrange
      const warehouse = await createTestWarehouse({ version: step - 1 })
      insertSurvivingRows(warehouse.db)

      // Act
      applyMigrations(warehouse.db, step)
      const rows = readSurvivingRows(warehouse.db)
      await warehouse.remove()

      // Assert
      expect(rows).toStrictEqual(expectedSurvivingRows())
    })
  }

  it('fits the current schema: the fixed rows insert and read back unchanged', async () => {
    // Arrange
    const warehouse = await createTestWarehouse()

    // Act
    insertSurvivingRows(warehouse.db)
    const rows = readSurvivingRows(warehouse.db)
    await warehouse.remove()

    // Assert
    expect(rows).toStrictEqual(expectedSurvivingRows())
  })
})
