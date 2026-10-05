// How a turn's last reply reads, by what the turn came to.
export type ClosingKind =
  | 'progress'
  | 'asks'
  | 'answer'
  | 'done'
  | 'handoff'
  | 'partly'
  | 'abandoned'
  | 'failed'
  | 'blocked'
  | 'unclear'

export interface IReplyCorpus {
  closing: Readonly<Record<ClosingKind, readonly string[]>>
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
    progress: [
      'The first part is in place in {file}. Next I will cover it with a test.',
      'That step is done and the tests still pass. One more change is left.',
    ],
    asks: [
      'Before I change {file}: should the old behaviour stay behind a flag, or go?',
      'I see two ways to do this. Do you want the smaller change or the cleaner one?',
    ],
    answer: [
      'It counts lines, not items: two of the same product show as one.',
      'It returns zero for an empty list, and the caller shows nothing.',
    ],
    done: [
      'Done: {work}. The tests pass and the change is ready for review.',
      'All set. {file} is updated and every test passes.',
    ],
    handoff: [
      'I stopped here so you can take it on: the change in {file} is written but not tested.',
      'The rest needs a decision from the team, so I left notes in the pull request.',
    ],
    partly: [
      'Part of it is done: {file} is split, but the last function still does two things.',
      'I got the first half in. The second needs a change to the tests I did not make.',
    ],
    abandoned: [
      'Leaving this as it is: the fix touches more of the billing flow than we planned.',
      'I will stop here and revert the change in {file}.',
    ],
    failed: [
      'The change did not fix it: one invoice still rounds the wrong way.',
      'The tests still fail after the change in {file}, so the cause is elsewhere.',
    ],
    blocked: [
      'I cannot go further until the tax rates are confirmed; the code matches the spec as written.',
      'This needs access to the payment sandbox, which this machine does not have.',
    ],
    unclear: [
      'The review found nothing certain: the form works, but the intent of one change is not clear to me.',
      'I could not tell whether the change in {file} is meant to stay.',
    ],
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
