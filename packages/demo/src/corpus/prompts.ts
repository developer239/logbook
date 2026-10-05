import type { PromptAct } from '@log-book/engine'

interface IPromptTemplate {
  act: PromptAct
  prompt: string
}

interface IOpeningPromptTemplate {
  act: PromptAct
  openingPrompt: string
}

export interface IPromptCorpus {
  // By act; a turn takes one of its act's templates.
  byAct: Readonly<Record<PromptAct, readonly IPromptTemplate[]>>
  // What a scripted session is started with, through `claude -p "..."` in another session.
  opening: readonly IOpeningPromptTemplate[]
}

// Slots: `{work}` the session's item of work, `{file}` a source file of its project.
export const PROMPTS: IPromptCorpus = {
  byAct: {
    task: [
      { act: 'task', prompt: '{work}. Start from {file}.' },
      { act: 'task', prompt: 'please {work}, the code is in {file}' },
      { act: 'task', prompt: 'can you {work}? keep the change small' },
    ],
    continue: [
      { act: 'continue', prompt: 'go on with the next step' },
      { act: 'continue', prompt: 'looks right, continue' },
      { act: 'continue', prompt: 'carry on, then run the tests again' },
    ],
    question: [
      { act: 'question', prompt: 'what does {file} do when the list is empty?' },
      { act: 'question', prompt: 'is there anything left before we tag it?' },
    ],
    answer: [
      { act: 'answer', prompt: 'yes, replace it and keep the old name' },
      { act: 'answer', prompt: 'the second option, and no flag' },
    ],
    report: [
      { act: 'report', prompt: 'the tests fail on my machine now, one case in {file}' },
      { act: 'report', prompt: 'I ran it locally and the total is still off by a cent' },
    ],
    other: [
      { act: 'other', prompt: 'thanks, that helps' },
      { act: 'other', prompt: 'ok, noted' },
    ],
  },
  opening: [
    { act: 'question', openingPrompt: 'explain in one paragraph what the cart badge counts' },
    { act: 'question', openingPrompt: 'say in two sentences whether the cart badge counts items or lines' },
  ],
}
