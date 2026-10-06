import type { PromptAct, ReplyCode, SessionOutcome } from '@log-book/engine'
import type { ProjectName } from './projects.js'
import type { IReactionTag } from './prompts.js'
import type { SubagentTaskName, TurnEvent, UseName } from './shapes.js'

// A turn's last reply: its text, with `[[...]]` marking the words a reply quote copies, and its reply codes.
interface IShowcaseClosing {
  text: string
  codes: readonly ReplyCode[]
}

// When a turn runs, in seconds: from the start of what holds it to its own start, and its length.
interface ITurnTime {
  at: number
  seconds: number
}

interface IShowcaseTurn extends ITurnTime {
  act: PromptAct
  prompt: string
  reactions: readonly IReactionTag[]
  // At the turn's start.
  events: readonly TurnEvent[]
  // In order, each after a reply of the agent.
  uses: readonly UseName[]
  // The developer interrupts the agent while the last use is still running.
  isInterrupted: boolean
  // Null for a turn the developer interrupts.
  closing: IShowcaseClosing | null
}

// A turn of the started session after the first, which its task gives.
interface IShowcaseFollowUp {
  act: PromptAct
  prompt: string
  uses: readonly UseName[]
  closing: string
}

export interface IShowcase {
  project: ProjectName
  // A work item of the project; the conversation is titled with it.
  work: string
  branch: string
  outcome: SessionOutcome
  // What its writer must declare.
  capabilities: readonly string[]
  // How long before the anchor it starts.
  startHoursBeforeAnchor: number
  // Times from the conversation's start.
  turns: readonly IShowcaseTurn[]
  // The session one turn starts: the task it is started with, its turns' times from its own start, and its turns
  // after the first.
  subagent: {
    task: SubagentTaskName
    turn: number
    // Seconds from the start of the turn that starts it.
    after: number
    times: readonly ITurnTime[]
    followUps: readonly IShowcaseFollowUp[]
  }
}

const CORRECTION: IReactionTag = {
  reaction: 'correction',
  about: 'last turn',
  target: 'verification',
  reach: 'project',
  hasSteps: true,
}
const PUSHBACK: IReactionTag = {
  reaction: 'pushback',
  about: 'last turn',
  target: 'process',
  reach: 'everywhere',
  hasSteps: true,
}
const PRAISE: IReactionTag = { reaction: 'praise', about: 'last turn', target: 'scope', reach: 'once', hasSteps: false }

const turn = (
  fields: Partial<IShowcaseTurn> & Pick<IShowcaseTurn, 'at' | 'seconds' | 'act' | 'prompt' | 'uses'>
): IShowcaseTurn => ({
  reactions: [],
  events: [],
  isInterrupted: false,
  closing: null,
  ...fields,
})

// The one conversation of the rich set that every capture of the conversation page shows: long, with turns of uneven
// length, steps of many kinds, a subagent, an interrupted commit and a test run that fails before it passes. Nothing
// of it comes from the seed; only its times move with the anchor.
export const SHOWCASE: IShowcase = {
  project: 'shop',
  work: 'add a discount code field to checkout',
  branch: 'feature/discount-codes',
  outcome: 'done',
  capabilities: ['nested-subagent', 'interrupt', 'git-branch'],
  startHoursBeforeAnchor: 98,
  turns: [
    turn({
      at: 0,
      seconds: 150,
      act: 'task',
      prompt: 'add a discount code field to checkout: a text field under the total, applied when the form is sent',
      uses: ['update-todos', 'read-source', 'search-text'],
      closing: {
        text: 'The total is computed in applyDiscount. [[Next I will add the field to the form.]]',
        codes: ['none'],
      },
    }),
    turn({
      at: 240,
      seconds: 40,
      act: 'question',
      prompt: 'does applyDiscount already cap a code above 100 percent?',
      uses: ['read-test', 'find-files'],
      closing: { text: 'No. Nothing caps it, and the one test covers a ten percent code only.', codes: ['none'] },
    }),
    turn({
      at: 360,
      seconds: 420,
      act: 'continue',
      prompt: 'then cap it and add the field',
      uses: ['edit-source', 'write-test'],
      closing: {
        text: 'Done. The field is in the form and [[a code over 100 percent now gives a free order]].',
        codes: ['unverified'],
      },
    }),
    turn({
      at: 840,
      seconds: 300,
      act: 'continue',
      prompt: 'you called it done without running a single test. run them first, then tell me',
      reactions: [CORRECTION],
      uses: ['run-tests', 'git-status'],
      closing: {
        text: 'The tests pass: [[one file, one test, all green]]. The new test file is not committed yet.',
        codes: ['verified'],
      },
    }),
    turn({
      at: 1980,
      seconds: 200,
      act: 'continue',
      prompt: 'now show an error under the field when a code is unknown',
      uses: ['read-source', 'edit-source', 'git-diff'],
      closing: { text: 'The form shows the error under the field. Two files changed.', codes: ['none'] },
    }),
    turn({
      at: 2280,
      seconds: 90,
      act: 'continue',
      prompt: 'good. check the form once more on a narrow screen',
      uses: ['git-status', 'git-commit'],
      isInterrupted: true,
    }),
    turn({
      at: 2400,
      seconds: 120,
      act: 'continue',
      prompt: 'stop, I did not ask you to commit. never commit until I say so',
      reactions: [PUSHBACK],
      uses: ['git-status'],
      closing: {
        text: 'You are right, I should not have started a commit. [[Nothing was committed]]; the changes are still unstaged.',
        codes: ['admits'],
      },
    }),
    turn({
      at: 2640,
      seconds: 1000,
      act: 'task',
      prompt: 'trace how a code gets from the form to the cart total, and check nothing else reads the raw percent',
      uses: ['spawn:trace-discount', 'read-source'],
      closing: {
        text: 'The trace is back: [[only applyDiscount reads the percent]], and it caps it first.',
        codes: ['verified'],
      },
    }),
    turn({
      at: 3780,
      seconds: 50,
      act: 'question',
      prompt: 'which test covers the error message?',
      uses: ['read-test', 'search-text'],
      closing: { text: 'None yet: the only test checks the total, not the message.', codes: ['none'] },
    }),
    turn({
      at: 3960,
      seconds: 240,
      act: 'continue',
      prompt: 'add a test for the message and run the whole suite with coverage',
      uses: ['write-test', 'edit-source', 'run-tests-slow'],
      closing: { text: 'Coverage is done: [[91 percent of lines, every test passing]].', codes: ['verified'] },
    }),
    turn({
      at: 4320,
      seconds: 180,
      act: 'continue',
      prompt: 'the field should read well for screen readers. look up how others label it',
      uses: ['web-search', 'read-source', 'edit-source'],
      closing: {
        text: 'The field has a visible label now, and the error is tied to it. [[I took the pattern from the first result]].',
        codes: ['discloses'],
      },
    }),
    turn({
      at: 4620,
      seconds: 300,
      act: 'continue',
      prompt: 'run the tests again',
      uses: ['run-tests-failing', 'run-tests-failing', 'run-tests-failing', 'edit-source', 'run-tests'],
      closing: {
        text: 'The first three runs failed: [[the total was rounded before the cap]]. With the order fixed the tests pass.',
        codes: ['verified'],
      },
    }),
    turn({
      at: 5040,
      seconds: 45,
      act: 'question',
      prompt: 'what changed since main?',
      uses: ['git-diff', 'read-source'],
      closing: { text: 'Two files: the form and the discount module, 11 lines in and 5 out.', codes: ['none'] },
    }),
    turn({
      at: 5220,
      seconds: 200,
      act: 'continue',
      prompt: 'call it a promo code in the label, nowhere else',
      uses: ['edit-source', 'run-tests'],
      closing: { text: 'The label reads Promo code; the tests still pass.', codes: ['none'] },
    }),
    turn({
      at: 5520,
      seconds: 260,
      act: 'continue',
      prompt: 'go on with the empty code case',
      events: ['compaction'],
      uses: ['read-source', 'search-text', 'edit-source', 'git-status'],
      closing: { text: 'An empty code now leaves the total as it is.', codes: ['none'] },
    }),
    turn({
      at: 5880,
      seconds: 150,
      act: 'continue',
      prompt: 'cover the empty code with a test',
      uses: ['write-test', 'run-tests'],
      closing: { text: 'The empty code test passes with the rest.', codes: ['verified'] },
    }),
    turn({
      at: 6120,
      seconds: 120,
      act: 'question',
      prompt: 'is anything left from the plan?',
      uses: ['read-test', 'git-diff'],
      closing: {
        text: 'Only the narrow screen check is left. [[Do you want it now, or left for the review?]]',
        codes: ['asks', 'options'],
      },
    }),
    turn({
      at: 6300,
      seconds: 200,
      act: 'answer',
      prompt: 'now, please',
      uses: ['update-todos', 'edit-source', 'run-tests'],
      closing: { text: 'On a narrow screen the field wraps under the total; the tests pass.', codes: ['none'] },
    }),
    turn({
      at: 6600,
      seconds: 100,
      act: 'continue',
      prompt: 'show me the final diff',
      uses: ['git-status', 'git-diff'],
      closing: { text: 'That is the whole change. [[Shall I commit it now?]]', codes: ['permission'] },
    }),
    turn({
      at: 6780,
      seconds: 120,
      act: 'continue',
      prompt: 'small and clean, thank you. yes, commit it',
      reactions: [PRAISE],
      uses: ['git-commit', 'git-status'],
      closing: { text: 'Committed on feature/discount-codes. The working tree is clean.', codes: ['none'] },
    }),
  ],
  subagent: {
    task: 'trace-discount',
    turn: 8,
    after: 40,
    times: [
      { at: 0, seconds: 150 },
      { at: 210, seconds: 170 },
      { at: 450, seconds: 190 },
      { at: 700, seconds: 180 },
    ],
    followUps: [
      {
        act: 'continue',
        prompt: 'now the cart page: does it read the percent anywhere?',
        uses: ['grep-code', 'read-source'],
        closing: 'No. The cart page reads only the total applyDiscount returns.',
      },
      {
        act: 'question',
        prompt: 'and the order email?',
        uses: ['search-text', 'read-test'],
        closing: 'The order email prints the total and never the percent.',
      },
      {
        act: 'continue',
        prompt: 'run the discount tests once to be sure',
        uses: ['run-tests'],
        closing: 'The discount tests pass.',
      },
    ],
  },
}
