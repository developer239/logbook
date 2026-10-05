import type { PromptAct, Reaction, ReactionAbout, ReactionReach, ReactionTarget } from '@log-book/engine'

interface IPromptTemplate {
  act: PromptAct
  prompt: string
}

interface IOpeningPromptTemplate {
  act: PromptAct
  openingPrompt: string
}

// One reaction a prompt carries. With `hasSteps`, it points at the last tool call of the turn before the prompt.
export interface IReactionTag {
  reaction: Reaction
  about: ReactionAbout
  target: ReactionTarget
  reach: ReactionReach
  hasSteps: boolean
}

interface IReactionTemplate {
  act: PromptAct
  // Numbered from 1 in this order.
  reactions: readonly IReactionTag[]
  prompt: string
}

export type ReactionName =
  | 'first-week'
  | 'stop-fetching'
  | 'release-check'
  | 'push-refused'
  | 'tests-interrupted'
  | 'meant-optional'
  | 'name-tests'
  | 'leave-the-drift'
  | 'use-the-script'
  | 'meant-saved-cart'
  | 'fix-in-code'
  | 'tests-first'
  | 'rates-in-repo'

export interface IPromptCorpus {
  // By act; a turn takes one of its act's templates.
  byAct: Readonly<Record<PromptAct, readonly IPromptTemplate[]>>
  // What a scripted session is started with, through `claude -p "..."` in another session.
  opening: readonly IOpeningPromptTemplate[]
  // The developer's reactions to the agent, by name; a turn takes the template of its act.
  reactions: Readonly<Record<ReactionName, readonly IReactionTemplate[]>>
}

const PUSHED_UNASKED: IReactionTag = {
  reaction: 'pushback',
  about: 'last turn',
  target: 'process',
  reach: 'project',
  hasSteps: true,
}
const UNTESTED_CLAIM: IReactionTag = {
  reaction: 'correction',
  about: 'last turn',
  target: 'verification',
  reach: 'everywhere',
  hasSteps: true,
}
const GOOD_DESIGN: IReactionTag = {
  reaction: 'praise',
  about: 'last turn',
  target: 'design',
  reach: 'once',
  hasSteps: false,
}
const FIRST_WEEK = [PUSHED_UNASKED, UNTESTED_CLAIM, GOOD_DESIGN]

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
  reactions: {
    // The second turn of the first session, whatever its act: with the two recent sessions it puts a correction, a
    // pushback and praise in two weeks for every seed. Its first reaction also suits a turn after a stop.
    'first-week': [
      {
        act: 'task',
        reactions: FIRST_WEEK,
        prompt:
          'the layout is good, but do not push before I ask, and run the tests before you say it works. then {work}',
      },
      {
        act: 'continue',
        reactions: FIRST_WEEK,
        prompt:
          'good structure. but do not push before I ask, and run the tests yourself before you say they pass. go on',
      },
      {
        act: 'question',
        reactions: FIRST_WEEK,
        prompt: 'the design is good, but why did you push without asking, and did you actually run the tests?',
      },
      {
        act: 'answer',
        reactions: FIRST_WEEK,
        prompt: 'yes, the design is fine. but stop pushing on your own, and run the tests before you call it done',
      },
      {
        act: 'report',
        reactions: FIRST_WEEK,
        prompt: 'the layout is fine, but you pushed before asking and the tests fail on my machine, so they never ran',
      },
      {
        act: 'other',
        reactions: FIRST_WEEK,
        prompt: 'nice design. no pushing without asking, though, and always run the tests before saying they pass',
      },
    ],
    'stop-fetching': [
      {
        act: 'continue',
        reactions: [
          { reaction: 'correction', about: 'last turn', target: 'process', reach: 'project', hasSteps: true },
        ],
        prompt: 'stop fetching docs, we settled the flow already. ask before you go online, then write it up',
      },
    ],
    'release-check': [
      {
        act: 'question',
        reactions: [
          { reaction: 'pushback', about: 'last turn', target: 'scope', reach: 'once', hasSteps: false },
          { reaction: 'praise', about: 'last turn', target: 'communication', reach: 'once', hasSteps: false },
        ],
        prompt: 'the summary reads well, but leave the changelog wording alone. is anything left before we tag it?',
      },
    ],
    'push-refused': [
      {
        act: 'continue',
        reactions: [
          { reaction: 'pushback', about: 'last turn', target: 'process', reach: 'everywhere', hasSteps: true },
        ],
        prompt: 'do not push until I ask. keep going with the checks instead',
      },
      {
        act: 'report',
        reactions: [
          { reaction: 'pushback', about: 'last turn', target: 'process', reach: 'everywhere', hasSteps: true },
        ],
        prompt: 'do not push until I ask. and the tests still fail on my machine',
      },
    ],
    'tests-interrupted': [
      {
        act: 'report',
        reactions: [
          { reaction: 'correction', about: 'last turn', target: 'process', reach: 'project', hasSteps: true },
        ],
        prompt:
          'I stopped that run: run only the tests for {file}, the full suite takes too long. the build fails here',
      },
    ],
    'meant-optional': [
      {
        act: 'continue',
        reactions: [
          { reaction: 'clarification', about: 'earlier turn', target: 'design', reach: 'once', hasSteps: false },
        ],
        prompt: 'about the first change: I meant the code field to stay optional. carry on with that in mind',
      },
    ],
    'name-tests': [
      {
        act: 'continue',
        reactions: [
          { reaction: 'teaching', about: 'earlier turn', target: 'style', reach: 'project', hasSteps: false },
        ],
        prompt: 'one thing from before: in this repo a test file is named after the module it tests. go on',
      },
    ],
    'leave-the-drift': [
      {
        act: 'continue',
        reactions: [{ reaction: 'redirect', about: 'earlier turn', target: 'other', reach: 'once', hasSteps: false }],
        prompt: 'forget the notes file from the start for now, and look at the late fee instead',
      },
    ],
    'use-the-script': [
      {
        act: 'continue',
        reactions: [
          { reaction: 'teaching', about: 'earlier turn', target: 'tools', reach: 'everywhere', hasSteps: false },
        ],
        prompt: 'for next time: run tests through the project script, not by hand. it sets the environment up',
      },
    ],
    'meant-saved-cart': [
      {
        act: 'answer',
        reactions: [{ reaction: 'clarification', about: 'last turn', target: 'scope', reach: 'once', hasSteps: false }],
        prompt: 'replace it. and I meant the saved cart, not the wishlist',
      },
    ],
    'fix-in-code': [
      {
        act: 'other',
        reactions: [{ reaction: 'redirect', about: 'last turn', target: 'scope', reach: 'once', hasSteps: false }],
        prompt: 'ok, leave the tracker alone now and fix the fee in the code',
      },
    ],
    'tests-first': [
      {
        act: 'continue',
        reactions: [{ reaction: 'praise', about: 'last turn', target: 'verification', reach: 'once', hasSteps: false }],
        prompt: 'nice that you ran the tests before anything else. continue',
      },
    ],
    'rates-in-repo': [
      {
        act: 'other',
        reactions: [
          { reaction: 'correction', about: 'last turn', target: 'tools', reach: 'everywhere', hasSteps: true },
        ],
        prompt: 'no web search for this, ever: the rates are in the repo. ok, go on',
      },
    ],
  },
}
