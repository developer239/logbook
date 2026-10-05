import { WarehouseStore } from '@log-book/warehouse'
import { DEFAULT_LABEL_MODEL } from './model.js'
import { renderBatchPrompt } from './runner/batch-prompt.js'
import { pendingRecords } from './runner/label-runner.js'
import type { LabelTaskName } from './tasks.js'
import { labelRunTasks } from './tasks/all-tasks.js'

// What Claude Code adds to every request, which Log Book never sees and so cannot show.
const FRAMING_NOTE =
  'Claude Code adds framing of its own to each request (its version, the folder it runs in, your platform, the date and ' +
  'the account it is logged in with), which Log Book does not see and so cannot show.'

export interface ILabelPreview {
  task: LabelTaskName
  // The `--system-prompt` argument of every batch.
  system: string
  // Each batch's prompt, what goes on stdin, with its number of records.
  batches: { prompt: string; records: number }[]
  note: string
}

// The next batches of a task exactly as a labelling run would send them now, without running `claude`: no detection,
// no lock and no run record. The model changes no byte of what is sent, so none is asked for.
export const previewLabelling = async (options: {
  warehousePath: string
  task: LabelTaskName
  batches?: number
}): Promise<ILabelPreview> => {
  const task = labelRunTasks().find((candidate) => candidate.name === options.task)
  if (task === undefined) {
    throw new Error(`No label task ${options.task}.`)
  }
  const reader = await WarehouseStore.openReadOnly(options.warehousePath)
  try {
    const pending = pendingRecords(reader, { task, model: DEFAULT_LABEL_MODEL, doneBy: 'any-model' })
    const count = options.batches ?? 1
    const batches = Array.from(
      { length: Math.min(count, Math.ceil(pending.length / task.batchSize)) },
      (_batch, index) => pending.slice(index * task.batchSize, (index + 1) * task.batchSize)
    )
    return {
      task: task.name,
      system: task.system,
      batches: batches.map((batch) => ({ prompt: renderBatchPrompt(task, batch), records: batch.length })),
      note: FRAMING_NOTE,
    }
  } finally {
    reader.close()
  }
}
