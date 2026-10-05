import { resolveWarehousePath } from '@log-book/warehouse'
import { exitCodeOf } from './errors.js'
import { taskNoun, taskWords } from './labelling-lines.js'
import { engineLabels, type LabelOperations } from './labels-run.js'
import { requiredTextOf, taskOf } from './option-values.js'
import type { CommandRunner } from './run-cli.js'

// `logbook labels drop`: one model's labels of one task, deleted all or none under the labelling lock, which a held
// lock refuses through its holder line. It needs no claude and writes no run record.
export const createLabelDropRunner =
  (labelsOf: LabelOperations = engineLabels): CommandRunner =>
  async ({ values, io }) => {
    const task = taskOf(values)
    const labeller = requiredTextOf(values, 'labeller')
    const dropped = await labelsOf(resolveWarehousePath()).drop({ task, labeller })
    io.stdout(
      dropped === 0
        ? `Nothing to drop: ${labeller} has labelled no ${taskNoun(task, 0)}.\n`
        : `Dropped ${labeller}'s labels of ${taskWords(task, dropped)}.\n`
    )
    return exitCodeOf('success')
  }
