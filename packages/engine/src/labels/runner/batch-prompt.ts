import type { ILabelCodeField, ILabelEntries, ILabelItem, ILabelRunTask, ILabelTextField } from './label-task.js'

// The highest code an example line shows, so it reads as a code and not as a count.
const EXAMPLE_CODE = 3

// Items are tagged `#00` up to the batch size within a batch; no warehouse id is sent.
const tagOf = (index: number): string => `#${String(index).padStart(2, '0')}`

const codesOf = (fields: readonly ILabelCodeField[]): string =>
  fields
    .map((field) =>
      field.isMultiple === true ? `its ${field.name} codes (one or more, joined by commas)` : `its ${field.name} code`
    )
    .join(', then ')

const textsOf = (texts: readonly ILabelTextField[]): string =>
  texts.map((text) => `, then " | " and ${text.description}`).join('')

const entriesFormat = (entries: ILabelEntries): string => {
  const refs = entries.refs === undefined ? '' : `, then \`@\` and ${entries.refs.description}`
  return (
    `Then one line for each ${entries.description}: the item's tag, then \`+\`, then ${codesOf(entries.fields)}, ` +
    `separated by spaces${refs}, for example \`#07 + ${entries.example}\`. An item can have several such lines or none.`
  )
}

const exampleOf = (task: ILabelRunTask): string => {
  const codes = task.fields
    .map((field) => {
      const code = String(Math.min(EXAMPLE_CODE, field.values.length - 1))
      return field.isMultiple === true ? `1,${code}` : code
    })
    .join(' ')
  return [`#07 ${codes}`, ...(task.texts ?? []).map((text) => text.example)].join(' | ')
}

// The batch prompt: the instructions, each code table, the answer format, then the tagged items.
export const renderBatchPrompt = (task: ILabelRunTask, batch: readonly ILabelItem[]): string => {
  const codeTables = [...task.fields, ...(task.entries?.fields ?? [])].map(
    (field) => `${field.name} codes:\n${field.values.map((value, code) => `${String(code)} = ${value}`).join('\n')}`
  )
  return [
    task.instructions.trim(),
    ...codeTables,
    `Answer with one line per item: the item's tag, then ${codesOf(task.fields)}, separated by spaces` +
      `${textsOf(task.texts ?? [])}, for example \`${exampleOf(task)}\`. Every tag gets exactly one such line.`,
    ...(task.entries === undefined ? [] : [entriesFormat(task.entries)]),
    'Write nothing else.',
    ...batch.map((item, index) => `### ${tagOf(index)}\n${item.text}`),
  ].join('\n\n')
}
