import type { ILabelRunTask } from '../runner/label-task.js'
import { outcomeTask } from './outcome-task.js'
import { promptTask } from './prompt-task.js'
import { replyTask } from './reply-task.js'
import { sessionTask } from './session-task.js'
import { shellTask } from './shell-task.js'
import { toolFailureTask } from './tool-failure-task.js'

// The six model tasks in the order every run follows; each loads its prompt file when it is built.
export const labelRunTasks = (): ILabelRunTask[] => [
  shellTask(),
  toolFailureTask(),
  sessionTask(),
  outcomeTask(),
  promptTask(),
  replyTask(),
]
