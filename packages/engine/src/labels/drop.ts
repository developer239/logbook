import { ERROR_CODES, LogBookError } from '@log-book/core'
import { RULES_LABELLER, takeLabelsLock, WarehouseStore, type LabelRecordType } from '@log-book/warehouse'
import { labelTaskNamed } from './task-named.js'

// Deletes one model's labels of one task, such as those of the model a user compared and did not choose. It writes
// label rows, so it holds the labelling lock as a run does: never under a running labelling run, whose pending list
// and `done` the labels belong to, and never behind a compaction's write lock. No detection, no model call, no run
// record. Returns the records whose labels went, on the task's main record type (prompts, not reactions).
export const dropLabels = async (options: {
  warehousePath: string
  task: string
  labeller: string
}): Promise<number> => {
  const info = labelTaskNamed(options.task)
  if (options.labeller === RULES_LABELLER) {
    throw new LogBookError(
      `The ${RULES_LABELLER} labels cannot be dropped: every sync rebuilds them. Pass a model's id.`,
      ERROR_CODES.VALIDATION_ERROR
    )
  }
  const groups = info.recordTypes.map((recordType: LabelRecordType) => ({
    recordType,
    names: info.fields.filter((field) => field.recordType === recordType).map((field) => field.name),
  }))
  // A held lock ends it with its holder before a row is deleted and before the warehouse is opened.
  const lock = takeLabelsLock(options.warehousePath, 'labels')
  try {
    const store = await WarehouseStore.open(options.warehousePath)
    try {
      return store.dropTaskLabels(options.labeller, groups)
    } finally {
      store.close()
    }
  } finally {
    lock.release()
  }
}
