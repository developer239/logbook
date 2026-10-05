import { ADAPTER_ERROR_CODES, sessionIdOf, timeSpan, type IImportedUnit } from '@log-book/adapter-api'
import { LogBookError, type ISqliteDb } from '@log-book/core'
import { ADAPTER_ID, SessionBuilder, type IMessageRow } from './session-builder.js'

interface ISessionRow {
  id: string
  parent_id: string | null
  directory: string | null
  title: string | null
  agent: string | null
  version: string | null
  time_created: number
}

// `opencode run` wraps every argument holding a space in double quotes before sending it, and stores nothing else
// that marks the session, so a root session whose first prompt is one whole quoted string with a space was scripted.
const isQuotedRunPrompt = (text: string | null): boolean =>
  text !== null && text.length > 1 && text.startsWith('"') && text.endsWith('"') && text.includes(' ')

const originalCompletions = (db: ISqliteDb, sessionId: string, hasV1Messages: boolean): Map<string, number> => {
  if (!hasV1Messages) {
    return new Map()
  }
  const rows = db
    .prepare(
      `SELECT id, json_extract(data, '$.time.completed') AS completed FROM message
       WHERE session_id = ? AND json_valid(data) AND json_extract(data, '$.time.completed') IS NOT NULL`
    )
    .all(sessionId) as { id: string; completed: number }[]
  return new Map(rows.map((row) => [row.id, row.completed]))
}

const readSession = (db: ISqliteDb, locator: string, hasV1Messages: boolean): IImportedUnit => {
  const row = db
    .prepare('SELECT id, parent_id, directory, title, agent, version, time_created FROM session_v2 WHERE id = ?')
    .get(locator) as ISessionRow | undefined
  if (row === undefined) {
    throw new LogBookError(`The OpenCode session ${locator} is gone.`, ADAPTER_ERROR_CODES.ADAPTER_UNIT_GONE)
  }
  const sessionId = sessionIdOf(ADAPTER_ID, row.id)
  const builder = new SessionBuilder(sessionId, row.version, originalCompletions(db, row.id, hasV1Messages))
  const messages = db
    .prepare(
      'SELECT id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ? ORDER BY seq'
    )
    .all(row.id) as IMessageRow[]
  for (const message of messages) {
    builder.add(message)
  }
  const span = timeSpan(builder.messages)
  return {
    sessions: [
      {
        session: {
          id: sessionId,
          harness: ADAPTER_ID,
          sourceId: row.id,
          origin: 'interactive',
          isScripted: row.parent_id === null && isQuotedRunPrompt(builder.firstUserText()),
          projectDir: row.directory,
          title: row.title,
          agent: row.agent,
          spawnedBySessionId: row.parent_id === null ? null : sessionIdOf(ADAPTER_ID, row.parent_id),
          spawnedByToolCallId: null,
          startedAt: span.startedAt ?? row.time_created,
          endedAt: span.endedAt,
        },
        messages: builder.messages,
        parts: builder.parts,
        toolCalls: builder.toolCalls,
        events: builder.events,
      },
    ],
    harnessVersion: row.version,
  }
}

// One session_v2 row with its message rows. A session no longer in the database is gone; any other failed read makes
// the unit unreadable, naming its locator.
export const importSession = (db: ISqliteDb, locator: string, hasV1Messages: boolean): IImportedUnit => {
  try {
    return readSession(db, locator, hasV1Messages)
  } catch (error: unknown) {
    if (error instanceof LogBookError) {
      throw error
    }
    throw new LogBookError(
      `Cannot read the OpenCode session ${locator}: ${error instanceof Error ? error.message : String(error)}`,
      ADAPTER_ERROR_CODES.ADAPTER_UNIT_UNREADABLE,
      error
    )
  }
}
