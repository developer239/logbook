import { ERROR_CODES, LogBookError } from '@log-book/core'
import type { IWarehouseReader } from '@log-book/warehouse'
import { SESSION_ORIGINS } from '../labels/vocabularies.js'
import { labelSql } from './label-sql.js'

export interface ISessionSummary {
  id: string
  harness: string
  origin: string
  title: string | null
  agent: string | null
  projectDir: string | null
  startedAt: number | null
  endedAt: number | null
  // Model and tool time over its turns, without idle stretches.
  activeMs: number | null
  messages: number
  toolCalls: number
  toolErrors: number
  tokensOutput: number
  models: string | null
  // What the session was for, from the model that labelled it last; null until labelled.
  goal: string | null
}

export interface ISearchHit {
  sessionId: string
  sessionTitle: string | null
  messageId: string
  actor: string
  kind: string
  at: number
  snippet: string
}

export interface ITreeNode {
  session: ISessionSummary
  // How this session was reached from its parent; null for the root.
  via: {
    kind: string
    confidence: string
    evidence: string
    toolName: string | null
    toolStartedAt: number | null
  } | null
  children: ITreeNode[]
  // True when the session was already shown higher up the tree, so its children are not repeated.
  isRepeat: boolean
}

export interface ITimelineEntry {
  at: number
  actor: string
  kind: string
  text: string
  toolName: string | null
  durationMs: number | null
  status: string | null
}

export interface IQueryResult {
  columns: string[]
  rows: unknown[][]
  isTruncated: boolean
}

export interface ISessionFilter {
  // An adapter id or its filter alias.
  harness?: string
  origin?: string
  // A text in the project directory.
  project?: string
  // A goal the session pursued, first or second.
  goal?: string
  outcome?: string
  since?: number
  limit?: number
}

const DEFAULT_LIMIT = 30
const MAX_TREE_DEPTH = 12

// A session field from the newest label a model gave it.
const modelLabel = (field: string): string => labelSql('session', 's.id', field, '<>')

const SESSION_SUMMARY_SQL = `
  SELECT s.id, s.harness, s.origin, s.title, s.agent, s.project_dir AS projectDir, s.started_at AS startedAt,
    s.ended_at AS endedAt,
    (SELECT SUM(t.model_ms + t.tool_ms) FROM turn t WHERE t.session_id = s.id) AS activeMs,
    (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messages,
    (SELECT COUNT(*) FROM tool_call t WHERE t.session_id = s.id) AS toolCalls,
    (SELECT COUNT(*) FROM tool_call t WHERE t.session_id = s.id AND t.status = 'error') AS toolErrors,
    (SELECT COALESCE(SUM(m.tokens_output), 0) FROM message m WHERE m.session_id = s.id) AS tokensOutput,
    (SELECT GROUP_CONCAT(DISTINCT m.model) FROM message m WHERE m.session_id = s.id AND m.model IS NOT NULL) AS models,
    ${modelLabel('goal')} AS goal
  FROM session s`

const invalid = (message: string): LogBookError => new LogBookError(message, ERROR_CODES.VALIDATION_ERROR)

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// Read access to the warehouse: listing, full-text search, a session's tree of subagents, its timeline, and read-only
// SQL. Every query reads the same harness-neutral tables, whichever harness a session came from.
export class WarehouseQueries {
  private readonly reader: IWarehouseReader

  constructor(reader: IWarehouseReader) {
    this.reader = reader
  }

  public readonly sessions = (filter: ISessionFilter): ISessionSummary[] => {
    const clauses: string[] = []
    const params: (string | number)[] = []
    const add = (clause: string, value: string | number | undefined): void => {
      if (value !== undefined) {
        clauses.push(clause)
        params.push(value)
      }
    }
    add('s.harness = ?', filter.harness === undefined ? undefined : this.harnessOf(filter.harness))
    add('s.origin = ?', filter.origin === undefined ? undefined : this.originOf(filter.origin))
    add('instr(s.project_dir, ?) > 0', filter.project)
    add(`? IN (${modelLabel('goal')}, ${modelLabel('secondGoal')})`, filter.goal)
    add(`${modelLabel('outcome')} = ?`, filter.outcome)
    add('s.started_at >= ?', filter.since)
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    return this.reader.all<ISessionSummary>(
      `${SESSION_SUMMARY_SQL}${where} ORDER BY s.started_at DESC, s.id LIMIT ?`,
      ...params,
      filter.limit ?? DEFAULT_LIMIT
    )
  }

  // FTS5 query syntax: words, "phrases", prefix*, AND/OR/NOT, NEAR().
  public readonly search = (query: string, limit: number = DEFAULT_LIMIT): ISearchHit[] => {
    try {
      return this.reader.all<ISearchHit>(
        `SELECT p.session_id AS sessionId, s.title AS sessionTitle, p.message_id AS messageId, m.actor, p.kind,
           m.created_at AS at, snippet(part_fts, 0, '[', ']', '…', 16) AS snippet
         FROM part_fts
         JOIN part p ON p.rowid = part_fts.rowid
         JOIN message m ON m.id = p.message_id
         JOIN session s ON s.id = p.session_id
         WHERE part_fts MATCH ?
         ORDER BY rank LIMIT ?`,
        query,
        limit
      )
    } catch (error: unknown) {
      throw invalid(
        `Search query \`${query}\` is not valid FTS5 syntax: ${reasonOf(error)}. ` +
          'Quote a phrase ("like this"), and use AND, OR, NOT and prefix* as operators.'
      )
    }
  }

  // A session given by its warehouse id or by the id its harness shows.
  public readonly resolveSession = (id: string): string => {
    const rows = this.reader.all<{ id: string }>('SELECT id FROM session WHERE id = ? OR source_id = ?', id, id)
    const [only] = rows
    if (rows.length === 1 && only !== undefined) {
      return only.id
    }
    if (rows.length > 1) {
      throw invalid(`Session id ${id} matches ${String(rows.length)} sessions; pass the warehouse id.`)
    }
    throw new LogBookError(
      `No session ${id} in the warehouse. Run logbook sync, or check the id.`,
      ERROR_CODES.NOT_FOUND
    )
  }

  // The session and every session it started through subagent links, each child under the link that reached it.
  public readonly tree = (sessionId: string): ITreeNode =>
    this.nodeOf(this.resolveSession(sessionId), null, new Set(), 0)

  // The session that started this one, followed up to the root.
  public readonly rootOf = (sessionId: string): string => {
    let current = this.resolveSession(sessionId)
    const seen = new Set([current])
    for (;;) {
      const parent = this.reader.get<{ parent: string }>(
        `SELECT parent_session_id AS parent FROM link WHERE child_session_id = ?
         ORDER BY CASE confidence WHEN 'exact' THEN 0 WHEN 'reconstructed' THEN 1 ELSE 2 END LIMIT 1`,
        current
      )
      if (parent === undefined || seen.has(parent.parent)) {
        return current
      }
      seen.add(parent.parent)
      current = parent.parent
    }
  }

  // What happened in a session in order: prompts, answers and tool calls with their durations. Harness messages,
  // reasoning and tool output are left out; search finds them.
  public readonly timeline = (sessionId: string): ITimelineEntry[] =>
    this.reader.all<ITimelineEntry>(
      `SELECT m.created_at AS at, m.actor, p.kind,
         CASE WHEN p.kind = 'tool_call' THEN t.input_json ELSE p.text END AS text,
         t.name AS toolName,
         CASE WHEN t.started_at IS NOT NULL AND t.ended_at IS NOT NULL THEN t.ended_at - t.started_at END AS durationMs,
         t.status
       FROM part p
       JOIN message m ON m.id = p.message_id
       LEFT JOIN tool_call t ON t.id = p.tool_call_id AND p.kind = 'tool_call'
       WHERE p.session_id = ? AND (p.kind = 'compaction' OR (p.kind IN ('text', 'tool_call') AND m.actor <> 'harness'))
       ORDER BY m.seq, p.idx`,
      sessionId
    )

  // Read-only SQL: the connection is read-only, so a write statement fails in SQLite itself.
  public readonly query = (sql: string, maxRows: number): IQueryResult => {
    let rows: Record<string, unknown>[]
    try {
      rows = this.reader.all<Record<string, unknown>>(sql)
    } catch (error: unknown) {
      throw invalid(`SQL failed: ${reasonOf(error)}`)
    }
    const columns = rows[0] === undefined ? [] : Object.keys(rows[0])
    return {
      columns,
      rows: rows.slice(0, maxRows).map((row) => columns.map((column) => row[column])),
      isTruncated: rows.length > maxRows,
    }
  }

  // An adapter id, or the filter alias of one, through the harness table.
  private readonly harnessOf = (value: string): string => {
    const row = this.reader.get<{ id: string }>('SELECT id FROM harness WHERE id = ? OR filter_alias = ?', value, value)
    if (row === undefined) {
      throw invalid(`No harness ${value} in the warehouse; pass an adapter id or its filter alias.`)
    }
    return row.id
  }

  private readonly originOf = (value: string): string => {
    if (!(SESSION_ORIGINS as readonly string[]).includes(value)) {
      throw invalid(`No origin ${value}; pass one of ${SESSION_ORIGINS.join(', ')}.`)
    }
    return value
  }

  private readonly summary = (sessionId: string): ISessionSummary => {
    const row = this.reader.get<ISessionSummary>(`${SESSION_SUMMARY_SQL} WHERE s.id = ?`, sessionId)
    if (row === undefined) {
      throw new LogBookError(`No session ${sessionId} in the warehouse.`, ERROR_CODES.NOT_FOUND)
    }
    return row
  }

  private readonly nodeOf = (
    sessionId: string,
    via: ITreeNode['via'],
    shown: Set<string>,
    depth: number
  ): ITreeNode => {
    const session = this.summary(sessionId)
    if (shown.has(sessionId) || depth >= MAX_TREE_DEPTH) {
      return { session, via, children: [], isRepeat: true }
    }
    shown.add(sessionId)
    const links = this.reader.all<{
      child: string
      kind: string
      confidence: string
      evidence: string
      toolName: string | null
      toolStartedAt: number | null
    }>(
      `SELECT l.child_session_id AS child, l.kind, l.confidence, l.evidence, t.name AS toolName,
         t.started_at AS toolStartedAt
       FROM link l
       LEFT JOIN tool_call t ON t.id = l.parent_tool_call_id
       JOIN session s ON s.id = l.child_session_id
       WHERE l.parent_session_id = ?
       ORDER BY COALESCE(t.started_at, s.started_at), l.child_session_id`,
      sessionId
    )
    return {
      session,
      via,
      isRepeat: false,
      children: links.map(({ child, ...link }) => this.nodeOf(child, link, shown, depth + 1)),
    }
  }
}
