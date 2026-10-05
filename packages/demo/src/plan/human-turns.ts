import type { ScriptStep } from '@log-book/adapter-api/source-writer'

type TReplyStep = Extract<ScriptStep, { kind: 'reply' }>

// A turn as the engine's prompt and reply tasks read it: from one human prompt to the next.
export interface IHumanTurn {
  prompt: ScriptStep
  // The calls between the human prompt before and this one, by key; null for the session's first human prompt.
  previousCalls: string[] | null
  // The agent's last text before the next human prompt, or null when it wrote none.
  reply: TReplyStep | null
}

// What the human typed as the warehouse records it: a prompt, or a command recorded as its file's body. A command typed
// by its name is the harness's, not a human prompt.
export const isHumanPrompt = (step: ScriptStep): boolean =>
  step.kind === 'prompt' || (step.kind === 'command' && step.body !== null)

// A session's human turns in order, from its own steps; a started session's steps stay inside its spawn step.
export const humanTurns = (steps: readonly ScriptStep[]): IHumanTurn[] => {
  const turns: IHumanTurn[] = []
  let calls: string[] | null = null
  for (const step of steps) {
    const current = turns.at(-1)
    if (isHumanPrompt(step)) {
      turns.push({ prompt: step, previousCalls: calls, reply: null })
      calls = []
    } else if (step.kind === 'call') {
      calls?.push(step.key)
    } else if (step.kind === 'reply' && step.text !== null && current !== undefined) {
      current.reply = step
    }
  }
  return turns
}
