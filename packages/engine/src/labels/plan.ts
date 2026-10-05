import { ERROR_CODES, LogBookError } from '@log-book/core'
import { WarehouseStore } from '@log-book/warehouse'
import { detectClaude, type ClaudeMissing } from '../claude/detect.js'
import { buildLabelFacts, type ILabelFacts } from './facts.js'
import { DEFAULT_LABEL_MODEL, isLabelModelId } from './model.js'
import { labelRunTasks } from './tasks/all-tasks.js'

export type LabelPlan =
  | { readonly status: 'ready'; readonly facts: ILabelFacts }
  | { readonly status: 'missing'; readonly missing: ClaudeMissing }

// The labelling run's model, refused as a usage error before anything else runs when it fails the model id check.
export const labelModelOf = (model: string | undefined): string => {
  const chosen = model ?? DEFAULT_LABEL_MODEL
  if (!isLabelModelId(chosen)) {
    throw new LogBookError(`${chosen} is not a model id.`, ERROR_CODES.VALIDATION_ERROR)
  }
  return chosen
}

// What a run would send now, for the web app's labelling page before a run exists: detection, then the facts from the
// warehouse opened read-only. No lock, no write, no run record and no `claude -p`; a sync before Start can change the
// counts, and the run counts again.
export const planLabelling = async (options: {
  warehousePath: string
  model?: string
  signal?: AbortSignal
}): Promise<LabelPlan> => {
  const model = labelModelOf(options.model)
  const detection = await detectClaude(options.signal)
  if (detection.status === 'missing') {
    return { status: 'missing', missing: detection.missing }
  }
  const reader = await WarehouseStore.openReadOnly(options.warehousePath)
  try {
    return {
      status: 'ready',
      facts: buildLabelFacts(reader, labelRunTasks(), detection, { model, doneBy: 'any-model' }),
    }
  } finally {
    reader.close()
  }
}
