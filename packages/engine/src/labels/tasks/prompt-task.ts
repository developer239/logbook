import { PromptLoaderService } from '@log-book/core'
import type { IWarehouseReader } from '@log-book/warehouse'
import type { ILabelCodeField, ILabelRunTask } from '../runner/label-task.js'
import { humanPrompts, renderSteps, replyBetween, stepsBetween, type IHumanPrompt } from './interaction-texts.js'
import { codeFields, itemPart, taskInfo } from './item-text.js'
import { flat } from './session-texts.js'

const SYSTEM = 'You label conversations for a telemetry analysis. Answer only with the requested lines.'
const STEPS = 12

const PARTS = {
  earlier: itemPart('prompt', 'prompt two before'),
  earlierReply: itemPart('prompt', 'reply to it'),
  previous: itemPart('prompt', 'previous prompt'),
  step: itemPart('prompt', 'input of each of the previous turn last 12 tool calls'),
  reply: itemPart('prompt', 'previous turn last reply'),
  prompt: itemPart('prompt', 'this prompt'),
}

// Whether the human interrupted the agent, or rejected a step, between the previous prompt and this one, from the
// adapters' events: no harness's wording is read.
const stopsBefore = (reader: IWarehouseReader, prompt: IHumanPrompt, previousAt: number): { kinds: Set<string> } => {
  const rows = reader.all<{ kind: string }>(
    `SELECT DISTINCT kind FROM event WHERE session_id = ? AND kind IN ('interrupted', 'tool-rejected')
       AND at > ? AND at <= ?`,
    prompt.sessionId,
    previousAt,
    prompt.createdAt
  )
  return { kinds: new Set(rows.map((row) => row.kind)) }
}

// The two turns before a prompt, newest last; the last turn's steps are numbered so a reaction can name them.
const renderPrompt = (reader: IWarehouseReader, prompt: IHumanPrompt): { text: string; refs: string[] } => {
  const { previous, earlier } = prompt
  if (previous === null) {
    return { text: ['[start of the session]', `[THIS PROMPT] ${flat(prompt.text, PARTS.prompt)}`].join('\n'), refs: [] }
  }
  const earlierReply = earlier === null ? null : replyBetween(reader, prompt.sessionId, earlier.seq, previous.seq)
  const reply = replyBetween(reader, prompt.sessionId, previous.seq, prompt.seq)
  const steps = stepsBetween(reader, prompt.sessionId, { fromSeq: previous.seq, toSeq: prompt.seq }, STEPS)
  const { kinds } = stopsBefore(reader, prompt, previous.createdAt)
  const text = [
    ...(earlier === null ? [] : [`[earlier prompt] ${flat(earlier.text, PARTS.earlier)}`]),
    ...(earlierReply === null ? [] : [`[earlier reply] ${flat(earlierReply.text, PARTS.earlierReply)}`]),
    `[last prompt] ${flat(previous.text, PARTS.previous)}`,
    ...renderSteps('[last turn steps]', steps, PARTS.step),
    ...(kinds.has('interrupted') ? ['[the developer interrupted the agent]'] : []),
    ...(kinds.has('tool-rejected') ? ['[the developer rejected a step]'] : []),
    `[last reply] ${reply === null ? '(none)' : flat(reply.text, PARTS.reply)}`,
    `[THIS PROMPT] ${flat(prompt.text, PARTS.prompt)}`,
  ].join('\n')
  return { text, refs: steps.map((step) => step.id) }
}

// What each human prompt does and how the human reacted to the agent: every human prompt of an interactive session.
export const promptTask = (): ILabelRunTask => {
  const info = taskInfo('prompt')
  const reactionFields: ILabelCodeField[] = info.fields.flatMap((field) =>
    field.recordType === 'reaction' && field.values !== null ? [{ name: field.name, values: field.values }] : []
  )
  return {
    name: info.name,
    recordType: 'message',
    version: info.version,
    fields: codeFields(info),
    entries: {
      recordType: 'reaction',
      description: 'reaction to what the agent did or said',
      fields: reactionFields,
      refs: {
        name: 'steps',
        description: 'the numbers of the steps it is about, joined by commas, when there are some',
      },
      example: '0 0 4 1 @3',
    },
    batchSize: info.batchSize,
    system: SYSTEM,
    instructions: PromptLoaderService.load(new URL('../../prompts/prompt-reaction.prompt.txt', import.meta.url)),
    candidates: (reader) =>
      humanPrompts(reader).map((prompt) => ({ recordId: prompt.id, ...renderPrompt(reader, prompt) })),
  }
}
