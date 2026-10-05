import type { ISqliteDb } from '@log-book/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_DESCRIPTION } from './schema-description.js'
import { createTestWarehouse, type ITestWarehouse } from './testing/index.js'

// The full-text index's own tables, which a reader never queries.
const FTS_SHADOW_PREFIX = 'part_fts_'
const TABLE_LINE = /^(?<table>[a-z_]+)\(/u

// The columns between a line's outer parentheses, split at the commas outside any nested parentheses; a column's name
// is its first word.
const columnsOf = (line: string, start: number): string[] => {
  const columns: string[] = []
  let depth = 1
  let current = ''
  for (const character of line.slice(start)) {
    depth += Number(character === '(') - Number(character === ')')
    if (depth === 0) {
      columns.push(current)
      break
    }
    if (depth === 1 && character === ',') {
      columns.push(current)
      current = ''
    } else {
      current += character
    }
  }
  return columns.map((column) => column.trim().split(/\s/u)[0] ?? '')
}

// Each table the description names, with the columns it names.
const describedTables = (): Map<string, string[]> =>
  new Map(
    SCHEMA_DESCRIPTION.split('\n').flatMap((line) => {
      const table = TABLE_LINE.exec(line)?.groups?.table
      return table === undefined ? [] : [[table, columnsOf(line, table.length + 1)] as const]
    })
  )

describe('SCHEMA_DESCRIPTION', () => {
  let warehouse: ITestWarehouse | null = null

  const db = (): ISqliteDb => {
    if (warehouse === null) {
      throw new Error('The test warehouse is not open.')
    }
    return warehouse.db
  }

  const tables = (): string[] =>
    (
      db()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]
    )
      .map((row) => row.name)
      .filter((name) => !name.startsWith(FTS_SHADOW_PREFIX))

  beforeEach(async () => {
    warehouse = await createTestWarehouse({ isInMemory: true })
  })

  afterEach(async () => {
    await warehouse?.remove()
    warehouse = null
  })

  it('names only tables and columns a warehouse has', () => {
    // Arrange
    const described = describedTables()

    // Act
    const missing = [...described].flatMap(([table, columns]) => {
      const present = new Set(
        (db().prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((row) => row.name)
      )
      return present.size === 0
        ? [table]
        : columns.filter((column) => !present.has(column)).map((column) => `${table}.${column}`)
    })

    // Assert
    expect({ missing, described: described.size }).toStrictEqual({ missing: [], described: 16 })
  })

  it('names every table of the schema', () => {
    // Act
    const unnamed = tables().filter((table) => !describedTables().has(table))

    // Assert
    expect(unnamed).toStrictEqual([])
  })
})
