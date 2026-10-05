import type { LabelTaskName } from './tasks.js'

export interface IItemPart {
  // The part as the table of what each request contains names it.
  part: string
  // Its clip size in characters, or null when it is never cut.
  chars: number | null
  // The end a cut keeps; every cut is on whole characters and a cut text ends with `…`.
  keep: 'start' | 'end'
}

const part = (name: string, chars: number | null, keep: IItemPart['keep'] = 'start'): IItemPart => ({
  part: name,
  chars,
  keep,
})

// What each labelling request contains, per task, in order: the code that builds items reads its clip sizes here, and
// the documentation site generates its table from it. Flattened parts have every run of whitespace as one space; no
// warehouse id is ever part of an item.
export const ITEM_CONTENTS: Readonly<Record<LabelTaskName, readonly IItemPart[]>> = {
  'shell': [part('(FAILED) or (ok)', null), part('command', 1200), part('output tail of a failed call', 300, 'end')],
  'tool-failure': [part('tool name as called', null), part('input', 400), part('error', 600)],
  'session': [
    part('origin, harness, agent, project, first command', null),
    part('title', 100),
    part('first prompt', 900),
    part('up to 3 more prompts', 350),
    part('last assistant text', 400),
  ],
  'outcome': [
    part('origin, harness, agent, project, message count, goal, second goal, summary', null),
    part('opening ask', 400),
    part('last two later prompts', 400),
    part('last assistant text', 700),
    part('assistant text before it', 300),
    part('error of a failed model request after the last reply', 200),
  ],
  'prompt': [
    part('prompt two before', 500),
    part('reply to it', 500),
    part('previous prompt', 900),
    part('input of each of the previous turn last 12 tool calls', 140),
    part('whether the human interrupted the agent or rejected a step', null),
    part('previous turn last reply', 1500),
    part('this prompt', 2000),
  ],
  'reply': [
    part('previous reply', 600),
    part('prompt', 1200),
    part('input of each of the turn last 25 tool calls', 140),
    part('reply', 2500),
  ],
}
