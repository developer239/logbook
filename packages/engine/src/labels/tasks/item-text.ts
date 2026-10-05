import { ITEM_CONTENTS, type IItemPart } from '../item-contents.js'
import type { ILabelCodeField } from '../runner/label-task.js'
import { LABEL_TASKS, type ILabelTaskInfo, type LabelTaskName } from '../tasks.js'

// One part of a task's item, as ITEM_CONTENTS names it.
export const itemPart = (task: LabelTaskName, name: string): IItemPart => {
  const found = ITEM_CONTENTS[task].find((candidate) => candidate.part === name)
  if (found === undefined) {
    throw new Error(`ITEM_CONTENTS has no part ${name} for the ${task} task.`)
  }
  return found
}

// A text cut to its part's size on whole characters, keeping the start or the end; the cut side shows `…`.
export const cutToPart = (text: string, part: IItemPart): string => {
  const characters = Array.from(text)
  if (part.chars === null || characters.length <= part.chars) {
    return text
  }
  return part.keep === 'start'
    ? `${characters.slice(0, part.chars).join('')}…`
    : `…${characters.slice(-part.chars).join('')}`
}

export const taskInfo = (name: LabelTaskName): ILabelTaskInfo => {
  const found = LABEL_TASKS.find((task) => task.name === name)
  if (found === undefined) {
    throw new Error(`No label task ${name}.`)
  }
  return found
}

// The task's code fields, with the vocabulary each answers from.
export const codeFields = (info: ILabelTaskInfo): ILabelCodeField[] =>
  info.fields.flatMap((field) =>
    field.values === null || field.recordType !== info.recordTypes[0]
      ? []
      : [{ name: field.name, values: field.values, ...(field.kind === 'codes' ? { isMultiple: true } : {}) }]
  )
