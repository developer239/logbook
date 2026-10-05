import type { WarehouseLockHeldError } from '@log-book/warehouse'
import { tildePath } from './format.js'

// The commands that rewrite the warehouse and hold both locks for their whole run.
const MAINTENANCE = new Set(['compact', 'forget'])
const DELETE_IT = 'If none is running, delete that file.'
const RUN_AGAIN = 'Run this again once it has ended.'

const LABELLING = 'a labelling run or a logbook labels drop'

// What the holder is doing, by the operation its lock file records; a labelling holder reads differently to a
// maintenance command, which rewrites the whole file.
const HOLDERS: Readonly<Record<string, (held: string, isMaintenance: boolean) => string>> = {
  sync: (held) => `A sync is already running on this warehouse ${held}. ${DELETE_IT}`,
  compact: (held) =>
    `Maintenance is running on this warehouse: logbook compact is rewriting it ${held}. ${RUN_AGAIN} ${DELETE_IT}`,
  forget: (held) =>
    'Maintenance is running on this warehouse: logbook forget is removing sessions from it and rewriting it ' +
    `${held}. ${RUN_AGAIN} ${DELETE_IT}`,
  labels: (held, isMaintenance) =>
    isMaintenance
      ? `A labelling command is running on this warehouse, ${LABELLING} ${held}. Compacting rewrites the whole ` +
        `file: run this again once it has ended. ${DELETE_IT}`
      : `Another labelling command is running on this warehouse, ${LABELLING} ${held}. Wait for it, or stop it ` +
        `where it was started. ${DELETE_IT}`,
}

// The line a command that met a held lock ends with: the holder, its pid and the lock file it met, so a user can clear
// a lock that a reused pid keeps held.
export const lockLine = (error: WarehouseLockHeldError, command: string, home: string): string => {
  const holder = HOLDERS[error.operation]
  if (holder === undefined) {
    throw new Error(`A lock records the unknown operation ${error.operation}`)
  }
  const held = `(pid ${String(error.pid)}, lock file ${tildePath(error.path, home)})`
  return holder(held, MAINTENANCE.has(command))
}
