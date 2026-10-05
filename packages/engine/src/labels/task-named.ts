import { ERROR_CODES, LogBookError } from '@log-book/core'
import { LABEL_TASK_NAMES, LABEL_TASKS, type ILabelTaskInfo } from './tasks.js'

// The task a name given at the boundary names; an unknown one is refused naming the six.
export const labelTaskNamed = (name: string): ILabelTaskInfo => {
  const info = LABEL_TASKS.find((task) => task.name === name)
  if (info === undefined) {
    throw new LogBookError(
      `No label task ${name}; pass one of ${LABEL_TASK_NAMES.join(', ')}.`,
      ERROR_CODES.VALIDATION_ERROR
    )
  }
  return info
}
