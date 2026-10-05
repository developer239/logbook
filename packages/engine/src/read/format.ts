import { MarkdownBuilder } from '@log-book/core'
import type { IQueryResult, ISearchHit, ISessionSummary, ITimelineEntry, ITreeNode } from './queries.js'

const TEXT_PREVIEW = 160
const QUERY_CELL_MAX = 300
const SECONDS_PER_MINUTE = 60

const formatDuration = (ms: number | null): string => {
  if (ms === null || ms < 0) {
    return '-'
  }
  const seconds = Math.round(ms / 1000)
  if (seconds < SECONDS_PER_MINUTE) {
    return `${String(seconds)}s`
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE)
  if (minutes < SECONDS_PER_MINUTE) {
    return `${String(minutes)}m${String(seconds % SECONDS_PER_MINUTE).padStart(2, '0')}s`
  }
  return `${String(Math.floor(minutes / SECONDS_PER_MINUTE))}h${String(minutes % SECONDS_PER_MINUTE).padStart(2, '0')}m`
}

// UTC, so an answer reads the same on every machine.
const formatTime = (ms: number | null): string =>
  ms === null ? '-' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19)

// Session text goes into table cells, so it is flattened to one line and its pipes are escaped; either would
// otherwise break the table.
const oneLine = (text: string, max: number): string => {
  const flat = text.replaceAll(/\s+/gu, ' ').trim()
  const cut = flat.length > max ? `${flat.slice(0, max)}…` : flat
  return cut.replaceAll('|', String.raw`\|`)
}

const spanOf = (session: ISessionSummary): number | null =>
  session.startedAt === null || session.endedAt === null ? null : session.endedAt - session.startedAt

const cell = (value: unknown): string => {
  if (value === null || value === undefined) {
    return ''
  }
  return oneLine(typeof value === 'object' ? JSON.stringify(value) : String(value), QUERY_CELL_MAX)
}

export const formatSessions = (sessions: readonly ISessionSummary[]): string => {
  const md = MarkdownBuilder.create().heading('Sessions', 1)
  if (sessions.length === 0) {
    return md.italic('No sessions match.').build()
  }
  return md
    .table(
      [
        'Session',
        'Harness',
        'Origin',
        'Goal',
        'Started',
        'Ended',
        'Took',
        'Active',
        'Msgs',
        'Tools',
        'Failed',
        'Output tokens',
        'Models',
        'Agent',
        'Project',
        'Title',
      ],
      sessions.map((session) => [
        session.id,
        session.harness,
        session.origin,
        session.goal ?? '-',
        formatTime(session.startedAt),
        formatTime(session.endedAt),
        formatDuration(spanOf(session)),
        formatDuration(session.activeMs),
        String(session.messages),
        String(session.toolCalls),
        String(session.toolErrors),
        String(session.tokensOutput),
        oneLine(session.models ?? '-', 60),
        session.agent ?? '-',
        oneLine(session.projectDir ?? '-', 60),
        oneLine(session.title ?? '', 60),
      ])
    )
    .build()
}

export const formatSearch = (query: string, hits: readonly ISearchHit[]): string => {
  const md = MarkdownBuilder.create().heading(`Search: ${query}`, 1)
  if (hits.length === 0) {
    return md.italic('No matches.').build()
  }
  return md
    .table(
      ['When', 'Session', 'Message', 'Actor', 'Kind', 'Match'],
      hits.map((hit) => [
        formatTime(hit.at),
        hit.sessionId,
        hit.messageId,
        hit.actor,
        hit.kind,
        oneLine(hit.snippet, 200),
      ])
    )
    .build()
}

const treeLine = (node: ITreeNode, depth: number): string[] => {
  const { session, via } = node
  const indent = '  '.repeat(depth)
  const how =
    via === null ? '' : `${via.kind} [${via.confidence}]${via.toolName === null ? '' : ` via ${via.toolName}`} -> `
  const failed = session.toolErrors > 0 ? ` (${String(session.toolErrors)} failed)` : ''
  const stats = `${formatDuration(spanOf(session))}, ${String(session.messages)} msgs, ${String(session.toolCalls)} tools${failed}`
  const agent = session.agent === null ? '' : `, ${session.agent}`
  return [
    `${indent}- ${how}${session.id} (${session.origin}${agent}) ${stats}${node.isRepeat ? ' (shown above)' : ''}`,
    ...(session.title === null || node.isRepeat ? [] : [`${indent}  ${oneLine(session.title, 100)}`]),
  ]
}

// The tree's lines, each session's children under it.
const walk = (node: ITreeNode, depth: number): string[] => [
  ...treeLine(node, depth),
  ...node.children.flatMap((child) => walk(child, depth + 1)),
]

// One line per session, indented under the link that reached it.
export const formatTree = (root: ITreeNode): string =>
  MarkdownBuilder.create().heading('Session tree', 1).codeBlock(walk(root, 0).join('\n')).build()

export const formatTimeline = (sessionId: string, entries: readonly ITimelineEntry[]): string => {
  const md = MarkdownBuilder.create().heading(`Timeline: ${sessionId}`, 1)
  if (entries.length === 0) {
    return md.italic('The session has no messages.').build()
  }
  return md
    .table(
      ['When', 'Actor', 'What', 'Took', 'Detail'],
      entries.map((entry) => [
        formatTime(entry.at),
        entry.actor,
        entry.kind === 'tool_call'
          ? `${entry.toolName ?? 'tool'}${entry.status === 'error' ? ' (failed)' : ''}`
          : entry.kind,
        formatDuration(entry.durationMs),
        oneLine(entry.text, TEXT_PREVIEW),
      ])
    )
    .build()
}

export const formatQuery = (title: string, result: IQueryResult, description?: string): string => {
  const md = MarkdownBuilder.create().heading(title, 1)
  if (description !== undefined) {
    md.text(description).blank()
  }
  if (result.rows.length === 0) {
    return md.italic('No rows.').build()
  }
  md.table(
    result.columns,
    result.rows.map((row) => row.map((value) => cell(value)))
  )
  if (result.isTruncated) {
    md.blank().italic(`Showing the first ${String(result.rows.length)} rows.`)
  }
  return md.build()
}
