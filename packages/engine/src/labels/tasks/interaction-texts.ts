import { IMAGE_PART_TEXT } from '@log-book/adapter-api'
import type { IWarehouseReader } from '@log-book/warehouse'
import type { IItemPart } from '../item-contents.js'
import { flat } from './session-texts.js'

interface IPromptRow {
  id: string
  sessionId: string
  seq: number
  createdAt: number
  text: string
}

// A prompt the human typed into an interactive session, with the two prompts before it in the session and the
// position where its own turn ends (the next prompt).
export interface IHumanPrompt extends IPromptRow {
  previous: IPromptRow | null
  earlier: IPromptRow | null
  nextSeq: number | null
}

export interface IStep {
  id: string
  name: string
  input: string
  status: string
}

// Every human prompt of the interactive sessions in session order: a `user` message, never a `harness` one, and not
// one that is only an image.
export const humanPrompts = (reader: IWarehouseReader): IHumanPrompt[] => {
  const rows = reader.all<IPromptRow & { parts: string }>(
    `SELECT m.id, m.session_id AS sessionId, m.seq, m.created_at AS createdAt,
       group_concat(p.text, char(10)) AS text, json_group_array(p.text) AS parts
     FROM message m JOIN session s ON s.id = m.session_id JOIN part p ON p.message_id = m.id AND p.kind = 'text'
     WHERE s.origin = 'interactive' AND m.actor = 'user'
     GROUP BY m.id ORDER BY m.session_id, m.seq`
  )
  const prompts = rows
    .filter(
      ({ text, parts }) =>
        text.trim().length > 0 && !(JSON.parse(parts) as string[]).every((part) => part.trim() === IMAGE_PART_TEXT)
    )
    .map(({ parts: _parts, ...row }) => row)
  return prompts.map((row, index) => {
    const ofSession = (offset: number): IPromptRow | null => {
      const other = prompts[index + offset]
      return other?.sessionId === row.sessionId ? other : null
    }
    return { ...row, previous: ofSession(-1), earlier: ofSession(-2), nextSeq: ofSession(1)?.seq ?? null }
  })
}

// The agent's last text between two points of a session: the reply that ends a turn.
export const replyBetween = (
  reader: IWarehouseReader,
  sessionId: string,
  fromSeq: number,
  toSeq: number | null
): { id: string; text: string } | null =>
  reader.get<{ id: string; text: string }>(
    `SELECT m.id, group_concat(p.text, char(10)) AS text
     FROM message m JOIN part p ON p.message_id = m.id AND p.kind = 'text'
     WHERE m.session_id = ? AND m.actor = 'assistant' AND m.seq > ? AND m.seq < ?
     GROUP BY m.id ORDER BY m.seq DESC LIMIT 1`,
    sessionId,
    fromSeq,
    toSeq ?? Number.MAX_SAFE_INTEGER
  ) ?? null

// The last `limit` tool calls between two points of a session, oldest first.
export const stepsBetween = (
  reader: IWarehouseReader,
  sessionId: string,
  range: { fromSeq: number; toSeq: number | null },
  limit: number
): IStep[] =>
  reader
    .all<IStep>(
      `SELECT t.id, t.name, t.input_json AS input, t.status FROM tool_call t JOIN message m ON m.id = t.message_id
       WHERE t.session_id = ? AND m.seq > ? AND m.seq < ? ORDER BY m.seq DESC, t.started_at DESC, t.id DESC LIMIT ?`,
      sessionId,
      range.fromSeq,
      range.toSeq ?? Number.MAX_SAFE_INTEGER,
      limit
    )
    .toReversed()

export const renderSteps = (heading: string, steps: readonly IStep[], input: IItemPart): string[] => [
  `${heading}${steps.length === 0 ? ' (none)' : ''}`,
  ...steps.map(
    (step, index) =>
      `  ${String(index + 1)}. ${step.name}${step.status === 'error' ? ' FAILED' : ''} ${flat(step.input, input)}`
  ),
]
