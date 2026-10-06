import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEMO_ERROR_CODES } from '../errors.js'
import type { IDemoPlan } from '../plan/types.js'
import { writeLabels } from './write-labels.js'

const AT = Date.UTC(2026, 8, 26, 19)
const CALL_KEY = 'session-1/c1'
const CALL_ID = 'call-0001'

let warehouse: ITestWarehouse

// The rows of a query as plain objects; SQLite's have no prototype.
const rows = (sql: string): Record<string, unknown>[] =>
  warehouse.db
    .prepare(sql)
    .all()
    .map((row) => ({ ...(row as Record<string, unknown>) }))

// A plan whose only label gives the call a model cause, in the one run that writes it.
const PLAN: Pick<IDemoPlan, 'labels' | 'ids'> = {
  labels: {
    labels: [
      {
        recordKey: CALL_KEY,
        recordType: 'tool_call',
        labeller: 'claude-haiku-4-5',
        version: 1,
        name: 'cause',
        value: 'invalid call',
        labelledAt: AT + 1000,
        run: 1,
      },
    ],
    runs: [
      {
        number: 1,
        command: 'logbook labels update',
        model: 'claude-haiku-4-5',
        pid: 40_001,
        startedAt: AT,
        endedAt: AT + 60_000,
        outcome: 'ok',
        error: null,
        tasks: [{ task: 'tool-failure', version: 1, planned: 1, done: 1 }],
      },
    ],
  },
  ids: { [CALL_KEY]: CALL_ID },
}

beforeEach(async () => {
  warehouse = await createTestWarehouse()
  // The sync's rules gave the failed call its cause.
  insert(warehouse.db, 'label', {
    record_type: 'tool_call',
    record_id: CALL_ID,
    labeller: 'rules',
    version: 1,
    name: 'cause',
    value: 'not found',
    labelled_at: AT,
  })
})

afterEach(async () => {
  await warehouse.remove()
})

describe('writeLabels', () => {
  it('refuses a plan that gives a model cause to a call the rules gave one, naming its key and cause, writing nothing', async () => {
    // Act
    const writing = writeLabels(warehouse.path, PLAN)

    // Assert
    await expect(writing).rejects.toMatchObject({
      code: DEMO_ERROR_CODES.DEMO_PLAN_INVALID,
      message: `The plan gives ${CALL_KEY} a model cause, which the rules already gave it.`,
    })
    expect(rows('SELECT COUNT(*) AS runs FROM label_run')).toStrictEqual([{ runs: 0 }])
  })

  it('writes the run, its task with done raised to planned, and the label under the record id, once the call is open', async () => {
    // Arrange
    warehouse.db.exec("DELETE FROM label WHERE labeller = 'rules'")

    // Act
    await writeLabels(warehouse.path, PLAN)

    // Assert
    expect({
      runs: rows('SELECT pid, started_at, ended_at, outcome, error, model FROM label_run'),
      tasks: rows('SELECT task, version, planned, done FROM label_run_task'),
      labels: rows('SELECT record_id, labeller, name, value, labelled_at FROM label'),
    }).toStrictEqual({
      runs: [
        { pid: 40_001, started_at: AT, ended_at: AT + 60_000, outcome: 'ok', error: null, model: 'claude-haiku-4-5' },
      ],
      tasks: [{ task: 'tool-failure', version: 1, planned: 1, done: 1 }],
      labels: [
        {
          record_id: CALL_ID,
          labeller: 'claude-haiku-4-5',
          name: 'cause',
          value: 'invalid call',
          labelled_at: AT + 1000,
        },
      ],
    })
  })
})
