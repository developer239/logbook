import type { ILabelCodeField, ILabelItem, ILabelRunTask, ILabelTextField } from './label-task.js'

// A text field is kept up to this many characters.
const TEXT_FIELD_CHARS = 200
const CODE = /^\d+$/u
const CODES = /^\d+(?:,\d+)*$/u
const TAGGED_LINE = /^`*#(?<tag>\d+)[ \t]+(?<entry>\+[ \t]+)?(?<rest>.*?)`*$/u

export type TLabelValues = { name: string; value: string }[]

// An item with the value the model chose for each field, and its entries in answer order.
export interface IItemAnswer {
  item: ILabelItem
  fields: TLabelValues
  entries: TLabelValues[]
}

interface ILineSpec {
  fields: readonly ILabelCodeField[]
  texts: readonly ILabelTextField[]
  refs?: { name: string } | undefined
}

const codeValue = (field: ILabelCodeField, token: string): { name: string; value: string } | null => {
  if (!(field.isMultiple === true ? CODES : CODE).test(token)) {
    return null
  }
  const values = [...new Set(token.split(','))].map((code) => field.values[Number(code)])
  return values.includes(undefined) ? null : { name: field.name, value: values.join(',') }
}

// The texts after `|`, the last of which may hold a `|` itself, each cut to its kept length.
const textValues = (texts: readonly ILabelTextField[], tail: readonly string[]): TLabelValues =>
  texts.map((text, index) => {
    const raw = index === texts.length - 1 ? tail.slice(index).join('|') : (tail[index] ?? '')
    return { name: text.name, value: Array.from(raw.trim()).slice(0, TEXT_FIELD_CHARS).join('') }
  })

// The ids an `@` token points at, by number, the first as 1; null when one points at none.
const pointedRefs = (refToken: string | undefined, refs: readonly string[]): string[] | null => {
  const pointed = (refToken?.slice(1).split(',') ?? []).map((number) => refs[Number(number) - 1])
  return pointed.every((ref) => ref !== undefined) ? pointed : null
}

// The codes before the texts, and the `@` token at their end when the spec has refs.
const tokensOf = (spec: ILineSpec, head: string): { tokens: string[]; refToken: string | undefined } => {
  const tokens = head
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0)
  const refToken = spec.refs !== undefined && tokens.at(-1)?.startsWith('@') === true ? tokens.pop() : undefined
  return { tokens, refToken }
}

// The values of one answer line after its tag (and `+`): the codes, an `@` reference when the spec has refs, then the
// texts after `|`. Null when anything is missing or out of range.
const parseLine = (spec: ILineSpec, rest: string, refs: readonly string[]): TLabelValues | null => {
  const [head = '', ...tail] = rest.split('|')
  const { tokens, refToken } = tokensOf(spec, head)
  if (tail.length < spec.texts.length || tokens.length !== spec.fields.length) {
    return null
  }
  const fields = spec.fields.map((field, index) => codeValue(field, tokens[index] ?? ''))
  const texts = textValues(spec.texts, tail)
  const pointed = pointedRefs(refToken, refs)
  if (!fields.every((field) => field !== null) || texts.some((text) => text.value.length === 0) || pointed === null) {
    return null
  }
  return [
    ...fields,
    ...texts,
    ...(spec.refs === undefined || pointed.length === 0 ? [] : [{ name: spec.refs.name, value: pointed.join(',') }]),
  ]
}

// Each entry once: two lines are the same entry only when every code and the step numbers match.
const distinct = (entries: readonly TLabelValues[]): TLabelValues[] => {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = JSON.stringify(entry)
    const isNew = !seen.has(key)
    seen.add(key)
    return isNew
  })
}

interface IParsedLines {
  mains: Map<number, TLabelValues[]>
  entries: Map<number, TLabelValues[]>
  isValid: boolean
}

// One tagged line into the parsed lines; a line that does not parse, or names a tag the batch does not hold, makes
// the answer invalid.
const addLine = (
  parsed: IParsedLines,
  specs: { main: ILineSpec; entry: ILineSpec | undefined },
  batch: readonly ILabelItem[],
  groups: Record<string, string | undefined>
): void => {
  const tag = Number(groups.tag)
  const item = batch[tag]
  const isEntry = groups.entry !== undefined
  const spec = isEntry ? specs.entry : specs.main
  const values = item === undefined || spec === undefined ? null : parseLine(spec, groups.rest ?? '', item.refs ?? [])
  if (values === null) {
    parsed.isValid = false
    return
  }
  const lines = isEntry ? parsed.entries : parsed.mains
  lines.set(tag, [...(lines.get(tag) ?? []), values])
}

const parseLines = (task: ILabelRunTask, batch: readonly ILabelItem[], text: string): IParsedLines => {
  const specs = {
    main: { fields: task.fields, texts: task.texts ?? [] },
    entry: task.entries === undefined ? undefined : { fields: task.entries.fields, texts: [], refs: task.entries.refs },
  }
  const parsed: IParsedLines = { mains: new Map(), entries: new Map(), isValid: true }
  for (const raw of text.split('\n')) {
    const groups = TAGGED_LINE.exec(raw.trim())?.groups
    if (groups !== undefined) {
      addLine(parsed, specs, batch, groups)
    }
  }
  return parsed
}

// Every item's values from a model's answer, or null when the answer is not kept: an item without exactly one valid
// main line, a code out of range, a tag the batch does not hold or an entry line that does not parse. A model that
// lost track of one tag may have shifted the others, so the whole answer goes.
export const parseBatchAnswer = (
  task: ILabelRunTask,
  batch: readonly ILabelItem[],
  text: string
): IItemAnswer[] | null => {
  const { mains, entries, isValid } = parseLines(task, batch, text)
  const answers = batch.map((item, index) => {
    const lines = mains.get(index) ?? []
    const [fields] = lines
    return lines.length === 1 && fields !== undefined
      ? { item, fields, entries: distinct(entries.get(index) ?? []) }
      : null
  })
  return isValid && answers.every((answer) => answer !== null) ? answers : null
}
