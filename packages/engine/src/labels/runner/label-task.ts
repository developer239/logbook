import type { IWarehouseReader, LabelRecordType } from '@log-book/warehouse'

// A field the model answers with a code: the index of its value in `values`. A multiple field takes several codes
// joined by commas (`3,5`) and stores their values joined the same way.
export interface ILabelCodeField {
  name: string
  values: readonly string[]
  isMultiple?: boolean
}

// A short text the model writes after the codes, stored as a field of its own.
export interface ILabelTextField {
  name: string
  // How the answer format names it.
  description: string
  example: string
}

// Records the model adds under an item, none or several, each a `+` line of codes (the reactions in a prompt). Entry
// n of record r is stored as record `r#n` of `recordType`. Entry lines hold no text.
export interface ILabelEntries {
  recordType: LabelRecordType
  // What one entry is, as the answer format names it.
  description: string
  fields: readonly ILabelCodeField[]
  // Numbers after `@` that point into the item's refs, stored as their ids joined by commas under `name`.
  refs?: { name: string; description: string }
  // The codes of an example line, such as `0 1 2 0 @2`.
  example: string
}

// One record to label, as the model reads it. `refs` are the ids an entry can point at by number, the first as 1.
export interface ILabelItem {
  recordId: string
  text: string
  refs?: readonly string[]
}

// A task as the runner sees it. The first field decides whether a record is labelled.
export interface ILabelRunTask {
  name: string
  recordType: LabelRecordType
  // The task's version in versions.json.
  version: number
  fields: readonly ILabelCodeField[]
  texts?: readonly ILabelTextField[]
  entries?: ILabelEntries
  batchSize: number
  // The one-line system text.
  system: string
  // The instructions, from the task's prompt file.
  instructions: string
  // The task's candidate records with their item text.
  candidates: (reader: IWarehouseReader) => ILabelItem[]
}
