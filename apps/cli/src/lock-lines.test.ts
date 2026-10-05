import { WarehouseLockHeldError } from '@log-book/warehouse'
import { describe, expect, it } from 'vitest'
import { errorReport } from './errors.js'

const HOME = '/home/example'
const PID = 48_213
const SYNC_LOCK = `${HOME}/.local/share/log-book/warehouse.db.lock`
const LABELS_LOCK = `${HOME}/.local/share/log-book/warehouse.db.labels.lock`
const LABELLING = ['labels update', 'labels run', 'labels drop']
const MAINTENANCE = ['compact', 'forget']

interface IRow {
  operation: string
  path: string
  line: string
  printedBy: readonly string[]
}

const ROWS: readonly IRow[] = [
  {
    operation: 'sync',
    path: SYNC_LOCK,
    line:
      'A sync is already running on this warehouse (pid 48213, lock file ~/.local/share/log-book/warehouse.db.lock). ' +
      'If none is running, delete that file.',
    printedBy: ['sync', ...MAINTENANCE],
  },
  {
    operation: 'compact',
    path: SYNC_LOCK,
    line:
      'Maintenance is running on this warehouse: logbook compact is rewriting it (pid 48213, lock file ' +
      '~/.local/share/log-book/warehouse.db.lock). Run this again once it has ended. If none is running, delete that ' +
      'file.',
    printedBy: ['sync', ...LABELLING, ...MAINTENANCE],
  },
  {
    operation: 'forget',
    path: SYNC_LOCK,
    line:
      'Maintenance is running on this warehouse: logbook forget is removing sessions from it and rewriting it (pid ' +
      '48213, lock file ~/.local/share/log-book/warehouse.db.lock). Run this again once it has ended. If none is ' +
      'running, delete that file.',
    printedBy: ['sync', ...LABELLING, ...MAINTENANCE],
  },
  {
    operation: 'labels',
    path: LABELS_LOCK,
    line:
      'Another labelling command is running on this warehouse, a labelling run or a logbook labels drop (pid 48213, ' +
      'lock file ~/.local/share/log-book/warehouse.db.labels.lock). Wait for it, or stop it where it was started. If ' +
      'none is running, delete that file.',
    printedBy: LABELLING,
  },
  {
    operation: 'labels',
    path: LABELS_LOCK,
    line:
      'A labelling command is running on this warehouse, a labelling run or a logbook labels drop (pid 48213, lock ' +
      'file ~/.local/share/log-book/warehouse.db.labels.lock). Compacting rewrites the whole file: run this again ' +
      'once it has ended. If none is running, delete that file.',
    printedBy: MAINTENANCE,
  },
]

const CASES = ROWS.flatMap((row) => row.printedBy.map((command) => [row.operation, command, row] as const))

describe('the line for a held lock', () => {
  it.each(CASES)('names a %s holder to %s, exiting 3', (operation, command, row) => {
    // Arrange
    const error = new WarehouseLockHeldError('held', { pid: PID, startedAt: 1, operation, path: row.path })

    // Act
    const report = errorReport(error, { version: '1.0.0', home: HOME, command })

    // Assert
    expect(report).toStrictEqual({ code: 3, line: row.line })
  })
})
