import type { ReplyCode } from '@log-book/engine'

// How a turn's last reply reads, by what the turn came to.
export type ClosingKind =
  | 'progress'
  | 'asks'
  | 'answer'
  | 'done'
  | 'handoff'
  | 'failed'
  | 'blocked'
  | 'unclear'
  | 'caves'
  | 'holds'
  | 'reverses'
  | 'corrects'
  | 'pushback'
  | 'permission'

// The reply codes every text of a kind carries. `[[...]]` marks the words a reply quote copies.
interface IClosingTemplates {
  codes: readonly ReplyCode[]
  texts: readonly string[]
}

export interface IReplyCorpus {
  closing: Readonly<Record<ClosingKind, IClosingTemplates>>
  // The thinking a turn's first reply records.
  reasoning: readonly string[]
  // What a compaction continues from.
  compactions: readonly string[]
  // Why a model request failed.
  requestErrors: readonly string[]
  // The agent an agent switch moves to.
  agents: readonly string[]
  // How a session went idle.
  idleOutcome: string
}

// Slots: `{work}` the session's item of work, `{file}` a source file of its project.
export const REPLIES: IReplyCorpus = {
  closing: {
    progress: {
      codes: ['none'],
      texts: [
        'The first part is in place in {file}. Next I will cover it with a test.',
        'That step is done. One more change is left.',
      ],
    },
    asks: {
      codes: ['asks', 'options'],
      texts: [
        'Before I change {file}: [[should the old behaviour stay behind a flag, or go?]]',
        'I see two ways to do this. [[Do you want the smaller change or the cleaner one?]]',
      ],
    },
    answer: {
      codes: ['none'],
      texts: [
        'It counts lines, not items: two of the same product show as one.',
        'It returns zero for an empty list, and the caller shows nothing.',
      ],
    },
    done: {
      codes: ['verified'],
      texts: [
        'Done: {work}. [[I ran the tests and they pass]], so the change is ready for review.',
        'All set. {file} is updated and [[every test passes on this branch]].',
      ],
    },
    handoff: {
      codes: ['discloses'],
      texts: [
        'I stopped here so you can take it on: [[the change in {file} is written but not tested]].',
        'The rest needs a decision from the team, and [[I left notes in the pull request]].',
      ],
    },
    failed: {
      codes: ['admits'],
      texts: [
        '[[The change did not fix it]]: one invoice still rounds the wrong way.',
        'I was wrong about the cause: [[the tests still fail after the change in {file}]].',
      ],
    },
    blocked: {
      codes: ['discloses'],
      texts: [
        'I cannot go further: [[the tax rates are not confirmed]], and the code matches the spec as written.',
        'This needs the payment sandbox, and [[this machine has no access to it]].',
      ],
    },
    unclear: {
      codes: ['unverified'],
      texts: [
        'The form should work now, [[though I did not run it]].',
        'The change in {file} looks right; [[I have not checked it in a browser]].',
      ],
    },
    caves: {
      codes: ['caves'],
      texts: [
        'You are right, I will do it your way and run only the tests for {file}.',
        'Understood, I will drop my approach and do it the way you said.',
      ],
    },
    holds: {
      codes: ['holds'],
      texts: [
        'I will leave the wording, but I still think the tag should wait: [[the late fee test has not run on main]].',
      ],
    },
    reverses: {
      codes: ['reverses'],
      texts: ['On second thought, [[my first version was wrong]]: the field stays optional and I put the check back.'],
    },
    corrects: {
      codes: ['corrects'],
      texts: [
        'The rates are not in the repo, though: [[the rates file was removed two releases ago]], so I read them from the tracker.',
      ],
    },
    pushback: {
      codes: ['pushback'],
      texts: [
        'I would rather finish the current fix first: [[switching now leaves the fee applied twice]].',
        'I would rather not drop that file yet: [[it holds the only trace of the drift]].',
      ],
    },
    permission: {
      codes: ['permission'],
      texts: [
        'The change is ready and the tests pass. [[May I push the branch?]]',
        'Everything is in place. [[Shall I open the pull request now?]]',
      ],
    },
  },
  reasoning: [
    'The change should stay inside {file}; the callers only need the new field.',
    'Reading the tests first tells me what the code is expected to keep doing.',
    'The smallest safe step is to change one function and run the tests after it.',
  ],
  compactions: [
    'Earlier in this session: {work}. The change in {file} is written; its tests still need a run.',
    'Summary so far: the work is {work}, and the open question is whether {file} keeps its old behaviour.',
  ],
  requestErrors: ['API Error: 529 Overloaded.', 'API Error: Connection dropped.'],
  agents: ['plan'],
  idleOutcome: 'completed',
}
