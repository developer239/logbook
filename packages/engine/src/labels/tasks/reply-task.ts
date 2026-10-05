import { PromptLoaderService } from '@log-book/core'
import type { IWarehouseReader } from '@log-book/warehouse'
import { promptFile } from '../../prompts.js'
import type { ILabelRunTask } from '../runner/label-task.js'
import { humanPrompts, renderSteps, replyBetween, stepsBetween, type IHumanPrompt } from './interaction-texts.js'
import { codeFields, itemPart, taskInfo } from './item-text.js'
import { flat, QUIET_MS } from './session-texts.js'

const SYSTEM = 'You label conversations for a telemetry analysis. Answer only with the requested lines.'
const STEPS = 25

const PARTS = {
  previous: itemPart('reply', 'previous reply'),
  prompt: itemPart('reply', 'prompt'),
  step: itemPart('reply', 'input of each of the turn last 25 tool calls'),
  reply: itemPart('reply', 'reply'),
}

const renderReply = (reader: IWarehouseReader, prompt: IHumanPrompt, reply: string): string => {
  const previousReply =
    prompt.previous === null ? null : replyBetween(reader, prompt.sessionId, prompt.previous.seq, prompt.seq)
  return [
    ...(previousReply === null ? [] : [`[agent's previous reply] ${flat(previousReply.text, PARTS.previous)}`]),
    `[developer's prompt] ${flat(prompt.text, PARTS.prompt)}`,
    ...renderSteps(
      '[steps the agent took]',
      stepsBetween(reader, prompt.sessionId, { fromSeq: prompt.seq, toSeq: prompt.nextSeq }, STEPS),
      PARTS.step
    ),
    `[THE REPLY] ${flat(reply, PARTS.reply)}`,
  ].join('\n')
}

// How the agent answered: the agent's last text before the next human prompt, in interactive sessions. A session's
// last turn may still be going, so its reply waits until the session is quiet.
export const replyTask = (): ILabelRunTask => {
  const info = taskInfo('reply')
  return {
    name: info.name,
    recordType: 'message',
    version: info.version,
    fields: codeFields(info),
    texts: [{ name: 'replyQuote', description: 'the quote', example: 'The tests pass; I did not run the e2e suite.' }],
    batchSize: info.batchSize,
    system: SYSTEM,
    instructions: PromptLoaderService.load(promptFile('reply.prompt.txt')),
    candidates: (reader) => {
      const quiet = new Set(
        reader
          .all<{ id: string }>(
            'SELECT session_id AS id FROM message GROUP BY session_id HAVING MAX(created_at) < ?',
            Date.now() - QUIET_MS
          )
          .map((session) => session.id)
      )
      return humanPrompts(reader).flatMap((prompt) => {
        const isOpen = prompt.nextSeq === null && !quiet.has(prompt.sessionId)
        const reply = isOpen ? null : replyBetween(reader, prompt.sessionId, prompt.seq, prompt.nextSeq)
        return reply === null ? [] : [{ recordId: reply.id, text: renderReply(reader, prompt, reply.text) }]
      })
    },
  }
}
