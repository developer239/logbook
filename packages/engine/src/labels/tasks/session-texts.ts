import { IMAGE_PART_TEXT } from '@log-book/adapter-api'
import type { IWarehouseReader } from '@log-book/warehouse'
import type { IItemPart } from '../item-contents.js'
import { cutToPart } from './item-text.js'

// A session's last turn may still be going: it is judged once the session has been quiet this long, because a label
// is never revised.
export const QUIET_MS = 60 * 60 * 1000

export interface ISessionHeader {
  id: string
  origin: string
  // The harness's display name, from the harness table; never its id.
  harnessName: string | null
  agent: string | null
  project: string | null
}

// The columns every session task's header reads, with the harness's display name.
export const SESSION_HEADER_SQL = `s.id, s.origin, h.name AS harnessName, s.agent, s.project_dir AS project`

// A text on one line, every run of whitespace one space, cut to its part's size.
export const flat = (text: string, part: IItemPart): string => cutToPart(text.replaceAll(/\s+/gu, ' ').trim(), part)

export const headerFields = (session: ISessionHeader): string[] => [
  `origin ${session.origin}`,
  `harness ${session.harnessName ?? '-'}`,
  `agent ${session.agent ?? '-'}`,
  `project ${session.project?.split('/').at(-1) ?? '-'}`,
]

const isImageOnly = (texts: readonly string[]): boolean => texts.every((text) => text.trim() === IMAGE_PART_TEXT)

// A session's messages by one actor in order, each message's text parts joined, empty ones left out. A prompt is a
// `user` message: the human's, or in a started session the calling agent's; a message the harness wrote in the user's
// name has the actor `harness` and is never one, and a prompt that is only an image is skipped.
export const messageTexts = (reader: IWarehouseReader, sessionId: string, actor: 'user' | 'assistant'): string[] => {
  const rows = reader.all<{ id: string; text: string }>(
    `SELECT m.id, p.text FROM message m JOIN part p ON p.message_id = m.id AND p.kind = 'text'
     WHERE m.session_id = ? AND m.actor = ? ORDER BY m.seq, p.idx`,
    sessionId,
    actor
  )
  const byMessage = new Map<string, string[]>()
  for (const row of rows) {
    byMessage.set(row.id, [...(byMessage.get(row.id) ?? []), row.text])
  }
  return [...byMessage.values()]
    .filter((texts) => texts.join(' ').trim().length > 0 && !(actor === 'user' && isImageOnly(texts)))
    .map((texts) => texts.join(' '))
}
