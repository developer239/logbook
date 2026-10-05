import type { LabelRecordType } from '@log-book/warehouse'
import versions from './tasks/versions.json' with { type: 'json' }
import {
  PROMPT_ACTS,
  REACTION_ABOUT,
  REACTION_REACH,
  REACTION_TARGETS,
  REACTIONS,
  REPLY_CODES,
  SECOND_GOALS,
  SESSION_GOALS,
  SESSION_OUTCOMES,
  SHELL_FAILURES,
  SHELL_PURPOSES,
  TOOL_FAILURE_CAUSES,
} from './vocabularies.js'

// The six model tasks, in the order every run follows.
export const LABEL_TASK_NAMES = ['shell', 'tool-failure', 'session', 'outcome', 'prompt', 'reply'] as const
export type LabelTaskName = (typeof LABEL_TASK_NAMES)[number]

// code: one value of `values`; codes: one or more, comma-joined; text: at most 200 characters; refs: tool call ids,
// comma-joined.
export type LabelFieldKind = 'code' | 'codes' | 'text' | 'refs'

export interface ILabelFieldInfo {
  name: string
  recordType: LabelRecordType
  kind: LabelFieldKind
  // The field's vocabulary tuple itself for a code or codes field, null otherwise.
  values: readonly string[] | null
}

export interface ILabelTaskInfo {
  name: LabelTaskName
  recordTypes: readonly LabelRecordType[]
  // The first field decides whether a record is labelled.
  fields: readonly ILabelFieldInfo[]
  batchSize: number
  // The task's value in tasks/versions.json, the one source of every task version.
  version: number
}

const field = (
  name: string,
  recordType: LabelRecordType,
  kind: LabelFieldKind,
  values: readonly string[] | null = null
): ILabelFieldInfo => ({ name, recordType, kind, values })

export const LABEL_TASKS: readonly ILabelTaskInfo[] = [
  {
    name: 'shell',
    recordTypes: ['tool_call'],
    fields: [
      field('purpose', 'tool_call', 'code', SHELL_PURPOSES),
      field('failure', 'tool_call', 'code', SHELL_FAILURES),
    ],
    batchSize: 25,
    version: versions.shell,
  },
  {
    name: 'tool-failure',
    recordTypes: ['tool_call'],
    fields: [field('cause', 'tool_call', 'code', TOOL_FAILURE_CAUSES)],
    batchSize: 25,
    version: versions['tool-failure'],
  },
  {
    name: 'session',
    recordTypes: ['session'],
    fields: [
      field('goal', 'session', 'code', SESSION_GOALS),
      field('secondGoal', 'session', 'code', SECOND_GOALS),
      field('summary', 'session', 'text'),
    ],
    batchSize: 20,
    version: versions.session,
  },
  {
    name: 'outcome',
    recordTypes: ['session'],
    fields: [field('outcome', 'session', 'code', SESSION_OUTCOMES), field('outcomeNote', 'session', 'text')],
    batchSize: 20,
    version: versions.outcome,
  },
  {
    name: 'prompt',
    recordTypes: ['message', 'reaction'],
    fields: [
      field('act', 'message', 'code', PROMPT_ACTS),
      field('reaction', 'reaction', 'code', REACTIONS),
      field('about', 'reaction', 'code', REACTION_ABOUT),
      field('target', 'reaction', 'code', REACTION_TARGETS),
      field('reach', 'reaction', 'code', REACTION_REACH),
      field('steps', 'reaction', 'refs'),
    ],
    batchSize: 8,
    version: versions.prompt,
  },
  {
    name: 'reply',
    recordTypes: ['message'],
    fields: [field('reply', 'message', 'codes', REPLY_CODES), field('replyQuote', 'message', 'text')],
    batchSize: 8,
    version: versions.reply,
  },
]
