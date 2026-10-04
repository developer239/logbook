import { afterEach, describe, expect, it } from 'vitest'
import {
  EVENT_COLUMNS,
  FORGOTTEN_COLUMNS,
  HARNESS_COLUMNS,
  LABEL_COLUMNS,
  LABEL_RUN_COLUMNS,
  LABEL_RUN_TASK_COLUMNS,
  LINK_COLUMNS,
  MESSAGE_COLUMNS,
  PART_COLUMNS,
  SESSION_COLUMNS,
  SESSION_COMMAND_COLUMNS,
  SOURCE_STATE_COLUMNS,
  SYNC_RUN_COLUMNS,
  TOOL_CALL_COLUMNS,
  TURN_COLUMNS,
} from './rows.js'
import { createTestWarehouse, type ITestWarehouse } from './testing/index.js'

const COLUMN_LISTS: Record<string, readonly string[]> = {
  event: EVENT_COLUMNS,
  forgotten: FORGOTTEN_COLUMNS,
  harness: HARNESS_COLUMNS,
  label: LABEL_COLUMNS,
  label_run: LABEL_RUN_COLUMNS,
  label_run_task: LABEL_RUN_TASK_COLUMNS,
  link: LINK_COLUMNS,
  message: MESSAGE_COLUMNS,
  part: PART_COLUMNS,
  session: SESSION_COLUMNS,
  session_command: SESSION_COMMAND_COLUMNS,
  source_state: SOURCE_STATE_COLUMNS,
  sync_run: SYNC_RUN_COLUMNS,
  tool_call: TOOL_CALL_COLUMNS,
  turn: TURN_COLUMNS,
}

describe('row column lists', () => {
  let warehouse: ITestWarehouse | null = null

  afterEach(async () => {
    await warehouse?.remove()
    warehouse = null
  })

  it('name every column of every table, in order', async () => {
    // Arrange
    warehouse = await createTestWarehouse()
    const { db } = warehouse
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'part_fts%' ORDER BY name")
        .all() as { name: string }[]
    ).map(({ name }) => name)

    // Act
    const columns = Object.fromEntries(
      tables.map((table) => [
        table,
        (db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map(({ name }) => name),
      ])
    )

    // Assert
    expect(columns).toStrictEqual(
      Object.fromEntries(Object.entries(COLUMN_LISTS).map(([table, list]) => [table, [...list]]))
    )
  })
})
