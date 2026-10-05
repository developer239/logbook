import { PromptLoaderService } from '@log-book/core'
import type { ILabelRunTask } from '../runner/label-task.js'
import { codeFields, itemPart, taskInfo } from './item-text.js'
import { flat, headerFields, messageTexts, SESSION_HEADER_SQL, type ISessionHeader } from './session-texts.js'

// The opening prompts a session item holds: a run gets as many as an interactive session, because a dispatched run
// may open with a greeting and bring its real ask in the continuations.
const PROMPTS = 4

interface ISessionRow extends ISessionHeader {
  title: string | null
  command: string | null
}

// What each session was for, from a model reading its opening: sessions of every origin with at least one prompt.
export const sessionTask = (): ILabelRunTask => {
  const info = taskInfo('session')
  const parts = {
    title: itemPart('session', 'title'),
    first: itemPart('session', 'first prompt'),
    later: itemPart('session', 'up to 3 more prompts'),
    reply: itemPart('session', 'last assistant text'),
  }
  return {
    name: info.name,
    recordType: 'session',
    version: info.version,
    fields: codeFields(info),
    texts: [
      {
        name: 'summary',
        description: 'one line of at most 12 words saying specifically what was done or asked',
        example: 'migrate the badge catalog to the new schema',
      },
    ],
    batchSize: info.batchSize,
    system: 'You label conversations for a telemetry analysis. Answer only with the requested lines.',
    instructions: PromptLoaderService.load(new URL('../../prompts/session-goal.prompt.txt', import.meta.url)),
    candidates: (reader) =>
      reader
        .all<ISessionRow>(
          `SELECT ${SESSION_HEADER_SQL}, s.title,
             (SELECT c.command FROM session_command c WHERE c.session_id = s.id ORDER BY c.at LIMIT 1) AS command
           FROM session s LEFT JOIN harness h ON h.id = s.harness ORDER BY s.id`
        )
        .flatMap((session) => {
          const prompts = messageTexts(reader, session.id, 'user').slice(0, PROMPTS)
          if (prompts.length === 0) {
            return []
          }
          const reply = messageTexts(reader, session.id, 'assistant').at(-1)
          const header = [
            ...headerFields(session),
            `title ${flat(session.title ?? '-', parts.title)}`,
            `command ${session.command ?? '-'}`,
          ]
          const text = [
            header.join(', '),
            ...prompts.map(
              (prompt, index) =>
                `[prompt ${String(index + 1)}] ${flat(prompt, index === 0 ? parts.first : parts.later)}`
            ),
            `[last reply] ${reply === undefined ? '(none)' : flat(reply, parts.reply)}`,
          ].join('\n')
          return [{ recordId: session.id, text }]
        }),
  }
}
