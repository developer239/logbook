import type { FilterField, IFilter } from '../filter'
import { harnessOfFilter, type StartedBy } from '../labels'
import type { IRange } from '../range'
import {
  activeMsOf,
  byAgent,
  failedOf,
  failureLabel,
  REACTIONS,
  literal,
  modelLabel,
  retryLoop,
  spawnedSessions,
  startedBy,
  stepsOf,
  titleOf,
  toolIs,
} from '../sql'
import { hasCause } from './calls'
import { allOf, type ISqlCondition, pagedRows } from './paged'

export interface IConversationRow {
  id: string
  title: string | null
  harness: string
  agent: string | null
  startedBy: StartedBy
  startedAt: number
  // The start where the conversation has no message.
  lastAt: number
  endedAt: number | null
  activeMs: number
  steps: number
  failed: number
  goal: string | null
  outcome: string | null
}

const PAGE_SIZE = 100

const BY_AGENT = byAgent('s')

const BY: Readonly<Record<string, string>> = {
  me: `s.origin = 'interactive'`,
  agent: BY_AGENT,
  script: `(s.origin <> 'interactive' AND NOT ${BY_AGENT})`,
}

const HAS: Readonly<Record<string, string>> = {
  failures: `EXISTS (SELECT 1 FROM tool_call tc WHERE tc.session_id = s.id AND tc.status = 'error')`,
  retry: `EXISTS (SELECT 1 FROM tool_call tc WHERE tc.session_id = s.id GROUP BY tc.name, tc.input_json
    HAVING ${retryLoop('tc')})`,
  correction: `EXISTS (SELECT 1 FROM ${REACTIONS} r WHERE r.session_id = s.id AND r.reaction = 'correction')`,
  spawned: `EXISTS ${spawnedSessions('s.id')}`,
}

const placeholders = (values: readonly unknown[]): string => values.map(() => '?').join(', ')

// The parser has already refused any other value.
const known = (conditions: Readonly<Record<string, string>>, value: string): string => {
  const condition = conditions[value]

  if (condition === undefined) {
    throw new Error(`No condition for ${value}`)
  }

  return condition
}

const conditionOf = (field: FilterField, values: string[]): ISqlCondition => {
  switch (field) {
    case 'goal':
      return { sql: `${modelLabel('session', 's.id', 'goal')} IN (${placeholders(values)})`, params: values }
    case 'outcome':
      return { sql: `${modelLabel('session', 's.id', 'outcome')} IN (${placeholders(values)})`, params: values }
    case 'by':
      return { sql: `(${values.map((value) => known(BY, value)).join(' OR ')})`, params: [] }
    case 'has':
      return { sql: `(${values.map((value) => known(HAS, value)).join(' OR ')})`, params: [] }
    case 'harness':
      return {
        sql: `s.harness IN (${placeholders(values)})`,
        params: values.map(harnessOfFilter),
      }
    case 'agent':
      return { sql: `s.agent IN (${placeholders(values)})`, params: values }
    case 'model':
      return {
        sql: `EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id AND m.actor = 'assistant'
          AND (${values.map(() => `m.model LIKE '%' || ${literal('?')} || '%' ESCAPE '\\'`).join(' OR ')}))`,
        params: values,
      }
    case 'project':
      return {
        sql: `(${values.map(() => `(s.project_dir = ? OR s.project_dir LIKE '%/' || ${literal('?')} ESCAPE '\\')`).join(' OR ')})`,
        params: values.flatMap((value) => [value, value]),
      }
    case 'tool':
      return {
        sql: `EXISTS (SELECT 1 FROM tool_call tc WHERE tc.session_id = s.id
          AND (${values.map(() => toolIs('tc.name')).join(' OR ')}))`,
        params: values.flatMap((value) => [value, value]),
      }
    case 'cause': {
      const cause = hasCause('tc.family', failureLabel('tc'), values)
      return {
        sql: `EXISTS (SELECT 1 FROM tool_call tc WHERE tc.session_id = s.id AND tc.status = 'error' AND ${cause.sql})`,
        params: cause.params,
      }
    }
  }
}

const textCondition = (text: readonly string[]): ISqlCondition => ({
  sql: text
    .map(
      () => `(s.id IN (SELECT p.session_id FROM part_fts JOIN part p ON p.rowid = part_fts.rowid
        WHERE part_fts MATCH ?) OR ${titleOf('s.id')} LIKE '%' || ${literal('?')} || '%' ESCAPE '\\')`
    )
    .join(' AND '),
  params: text.flatMap((said) => [`"${said.replaceAll('"', '""')}"`, said]),
})

const COLUMNS = `s.id, ${titleOf('s.id')} AS title, s.harness, s.agent, ${startedBy('s')} AS startedBy,
  s.started_at AS startedAt,
  COALESCE((SELECT MAX(m.created_at) FROM message m WHERE m.session_id = s.id), s.started_at) AS lastAt,
  s.ended_at AS endedAt,
  ${activeMsOf('s')} AS activeMs, ${stepsOf('s')} AS steps, ${failedOf('s')} AS failed,
  ${modelLabel('session', 's.id', 'goal')} AS goal, ${modelLabel('session', 's.id', 'outcome')} AS outcome`

export const conversations = (
  filter: IFilter,
  range: IRange,
  page: number
): { rows: IConversationRow[]; total: number; pageSize: number } => {
  const where = allOf([
    { sql: 's.started_at >= ? AND s.started_at < ?', params: [range.from, range.to] },
    ...[...filter.terms.entries()].map(([field, values]) => conditionOf(field, values)),
    ...(filter.text.length === 0 ? [] : [textCondition(filter.text)]),
  ])

  const { rows, total } = pagedRows<IConversationRow>(
    { columns: COLUMNS, from: 'session s', where, order: 'lastAt DESC, s.id' },
    page,
    PAGE_SIZE
  )

  return { rows, total, pageSize: PAGE_SIZE }
}
