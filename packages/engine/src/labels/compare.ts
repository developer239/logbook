import { MarkdownBuilder } from '@log-book/core'
import { WarehouseStore, type IWarehouseReader, type LabelRecordType } from '@log-book/warehouse'
import { labelTaskNamed } from './task-named.js'
import type { ILabelFieldInfo, ILabelTaskInfo } from './tasks.js'

const DISAGREEMENTS_SHOWN = 8
const PERCENT = 100

interface IPairCount {
  first: string
  second: string
  count: number
}

interface ILabelFieldComparison {
  field: string
  compared: number
  agreed: number
  // The commonest pairs of different answers, most frequent first.
  disagreements: IPairCount[]
}

// A multi-code field's value as the set of its codes, so the same codes in another order agree.
const normalised = (field: ILabelFieldInfo, value: string): string =>
  field.kind === 'codes' ? value.split(',').toSorted().join(',') : value

// The commonest pairs first; equal counts in the order of their first value, so the list reads the same every time.
const byCountThenValue = (left: IPairCount, right: IPairCount): number => {
  if (right.count !== left.count) {
    return right.count - left.count
  }
  return left.first < right.first ? -1 : 1
}

const tally = (field: string, pairs: readonly IPairCount[]): ILabelFieldComparison => {
  const sorted = pairs.toSorted(byCountThenValue)
  return {
    field,
    compared: sorted.reduce((sum, pair) => sum + pair.count, 0),
    agreed: sorted.filter((pair) => pair.first === pair.second).reduce((sum, pair) => sum + pair.count, 0),
    disagreements: sorted.filter((pair) => pair.first !== pair.second).slice(0, DISAGREEMENTS_SHOWN),
  }
}

const countPairs = (pairs: readonly [string, string][]): IPairCount[] => {
  const counts = new Map<string, IPairCount>()
  for (const [first, second] of pairs) {
    const key = JSON.stringify([first, second])
    const counted = counts.get(key) ?? { first, second, count: 0 }
    counts.set(key, { ...counted, count: counted.count + 1 })
  }
  return [...counts.values()]
}

// A code field on the records both labellers labelled at the task's current version.
const compareField = (
  reader: IWarehouseReader,
  info: ILabelTaskInfo,
  field: ILabelFieldInfo,
  labellers: { first: string; second: string }
): ILabelFieldComparison => {
  const rows = reader.all<{ first: string; second: string }>(
    `SELECT a.value AS first, b.value AS second FROM label a
     JOIN label b ON b.record_type = a.record_type AND b.record_id = a.record_id AND b.name = a.name
       AND b.version = a.version AND b.labeller = ?
     WHERE a.record_type = ? AND a.name = ? AND a.version = ? AND a.labeller = ?`,
    labellers.second,
    field.recordType,
    field.name,
    info.version,
    labellers.first
  )
  return tally(field.name, countPairs(rows.map((row) => [normalised(field, row.first), normalised(field, row.second)])))
}

// The prompt a reaction belongs to: `r` of the reaction id `r#n`.
const reactionPrompt = (reactionId: string): string => reactionId.slice(0, reactionId.lastIndexOf('#'))

// A task's entries compared as a set per record: the distinct values of their first field (the kinds of reaction a
// prompt has), `none` for a labelled record without entries.
const compareEntries = (
  reader: IWarehouseReader,
  info: ILabelTaskInfo,
  entryField: ILabelFieldInfo,
  labellers: { first: string; second: string }
): ILabelFieldComparison => {
  const [mainField] = info.fields
  const setsOf = (labeller: string): Map<string, string> => {
    const sets = new Map<string, Set<string>>(
      reader
        .all<{ id: string }>(
          'SELECT DISTINCT record_id AS id FROM label WHERE record_type = ? AND name = ? AND version = ? AND labeller = ?',
          mainField?.recordType ?? '',
          mainField?.name ?? '',
          info.version,
          labeller
        )
        .map(({ id }) => [id, new Set<string>()])
    )
    for (const row of reader.all<{ id: string; value: string }>(
      'SELECT record_id AS id, value FROM label WHERE record_type = ? AND name = ? AND version = ? AND labeller = ?',
      entryField.recordType,
      entryField.name,
      info.version,
      labeller
    )) {
      sets.get(reactionPrompt(row.id))?.add(row.value)
    }
    return new Map([...sets].map(([id, set]) => [id, set.size === 0 ? 'none' : [...set].toSorted().join(', ')]))
  }
  const [firstSets, secondSets] = [setsOf(labellers.first), setsOf(labellers.second)]
  const pairs = [...firstSets].flatMap(([id, first]): [string, string][] => {
    const second = secondSets.get(id)
    return second === undefined ? [] : [[first, second]]
  })
  return tally(`${entryField.name} set`, countPairs(pairs))
}

const formatComparison = (first: string, second: string, fields: readonly ILabelFieldComparison[]): string => {
  const md = MarkdownBuilder.create().heading(`Labels: ${first} against ${second}`, 1)
  const compared = fields.filter((field) => field.compared > 0)
  if (compared.length === 0) {
    return md.text('The two labellers have labelled no record in common.').build()
  }
  for (const field of compared) {
    md.heading(field.field, 2).field(
      'Agreed',
      `${String(field.agreed)} of ${String(field.compared)} (${String(Math.round((PERCENT * field.agreed) / field.compared))}%)`
    )
    md.blank()
    // A table ends with its own blank line.
    if (field.disagreements.length > 0) {
      md.table(
        [first, second, 'records'],
        field.disagreements.map((pair) => [pair.first, pair.second, String(pair.count)])
      )
    }
  }
  return md.build()
}

// How often two labellers agree on the records both labelled, field by field, with the commonest disagreements: with
// a fixed sample labelled by two models, how a user measures the default model's trade on their own data. It only
// reads: the warehouse opened read-only, no lock, nothing written.
export const compareLabellers = async (options: {
  warehousePath: string
  task: string
  first: string
  second: string
}): Promise<string> => {
  const info = labelTaskNamed(options.task)
  const mainType: LabelRecordType | undefined = info.recordTypes[0]
  const codeFields = info.fields.filter((field) => field.kind === 'code' || field.kind === 'codes')
  const labellers = { first: options.first, second: options.second }
  const reader = await WarehouseStore.openReadOnly(options.warehousePath)
  try {
    const main = codeFields.filter((field) => field.recordType === mainType)
    const [entryField] = codeFields.filter((field) => field.recordType !== mainType)
    const fields = [
      ...main.map((field) => compareField(reader, info, field, labellers)),
      ...(entryField === undefined ? [] : [compareEntries(reader, info, entryField, labellers)]),
    ]
    return formatComparison(options.first, options.second, fields)
  } finally {
    reader.close()
  }
}
