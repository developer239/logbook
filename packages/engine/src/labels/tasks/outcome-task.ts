import { PromptLoaderService } from '@log-book/core'
import { promptFile } from '../../prompts.js'
import { labelSql } from '../../read/label-sql.js'
import type { ILabelRunTask } from '../runner/label-task.js'
import { codeFields, itemPart, taskInfo } from './item-text.js'
import { flat, headerFields, messageTexts, QUIET_MS, SESSION_HEADER_SQL, type ISessionHeader } from './session-texts.js'

const LATER_PROMPTS = 2

interface IOutcomeRow extends ISessionHeader {
  messages: number
  goal: string | null
  secondGoal: string | null
  summary: string | null
  lastError: string | null
}

const goalOf = (session: IOutcomeRow): string => {
  if (session.goal === null) {
    return 'goal -'
  }
  const second = session.secondGoal === null || session.secondGoal === 'none' ? '' : ` then ${session.secondGoal}`
  return `goal ${session.goal}${second}`
}

// How each quiet session ended, from a model reading its end: the ask, the last prompts and replies, and a model
// request that failed after the last reply. It runs after the session task and reads the goals it wrote; which records
// are pending never depends on them.
export const outcomeTask = (): ILabelRunTask => {
  const info = taskInfo('outcome')
  const parts = {
    ask: itemPart('outcome', 'opening ask'),
    prompt: itemPart('outcome', 'last two later prompts'),
    lastReply: itemPart('outcome', 'last assistant text'),
    replyBefore: itemPart('outcome', 'assistant text before it'),
    error: itemPart('outcome', 'error of a failed model request after the last reply'),
  }
  const render = (reader: Parameters<ILabelRunTask['candidates']>[0], session: IOutcomeRow): string | null => {
    const [ask, ...later] = messageTexts(reader, session.id, 'user')
    if (ask === undefined) {
      return null
    }
    const replies = messageTexts(reader, session.id, 'assistant').slice(-2)
    const laterPrompts = later.slice(-LATER_PROMPTS)
    return [
      [
        ...headerFields(session),
        `${String(session.messages)} messages`,
        goalOf(session),
        `summary ${session.summary ?? '-'}`,
      ].join(', '),
      `[ask] ${flat(ask, parts.ask)}`,
      ...laterPrompts.map(
        (text, index) =>
          `[${index === laterPrompts.length - 1 ? 'last prompt' : 'prompt before'}] ${flat(text, parts.prompt)}`
      ),
      ...replies.map((text, index) =>
        index === replies.length - 1
          ? `[last reply] ${flat(text, parts.lastReply)}`
          : `[reply before] ${flat(text, parts.replyBefore)}`
      ),
      ...(replies.length === 0 ? ['[last reply] (none)'] : []),
      ...(session.lastError === null
        ? []
        : [`[ended with a failed model request] ${flat(session.lastError, parts.error)}`]),
    ].join('\n')
  }
  return {
    name: info.name,
    recordType: 'session',
    version: info.version,
    fields: codeFields(info),
    texts: [
      {
        name: 'outcomeNote',
        description: 'one line of at most 12 words saying what was delivered, what was left or what stopped it',
        example: 'migration written and tested; deploy left to the human',
      },
    ],
    batchSize: info.batchSize,
    system: 'You label conversations for a telemetry analysis. Answer only with the requested lines.',
    instructions: PromptLoaderService.load(promptFile('session-outcome.prompt.txt')),
    candidates: (reader) =>
      reader
        .all<IOutcomeRow>(
          `SELECT ${SESSION_HEADER_SQL},
             (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messages,
             ${labelSql('session', 's.id', 'goal', '<>')} AS goal,
             ${labelSql('session', 's.id', 'secondGoal', '<>')} AS secondGoal,
             ${labelSql('session', 's.id', 'summary', '<>')} AS summary,
             (SELECT COALESCE(json_extract(e.data_json, '$.error.message'), json_extract(e.data_json, '$.error'))
               FROM event e WHERE e.session_id = s.id AND e.kind = 'error'
                 AND e.at > COALESCE((SELECT MAX(m.created_at) FROM message m
                   WHERE m.session_id = s.id AND m.actor = 'assistant'), 0)
               ORDER BY e.at DESC LIMIT 1) AS lastError
           FROM session s LEFT JOIN harness h ON h.id = s.harness
           WHERE (SELECT MAX(m.created_at) FROM message m WHERE m.session_id = s.id) < ?
           ORDER BY s.id`,
          Date.now() - QUIET_MS
        )
        .flatMap((session) => {
          const text = render(reader, session)
          return text === null ? [] : [{ recordId: session.id, text }]
        }),
  }
}
