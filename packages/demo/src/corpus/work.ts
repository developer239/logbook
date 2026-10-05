import type { SessionGoal, SessionOutcome } from '@log-book/engine'
import type { ProjectName } from './projects.js'

export interface IWorkItem {
  title: string
  goal: SessionGoal
  // The outcomes a session on this item may end with.
  outcomes: readonly SessionOutcome[]
  // A session's summary label, at most 200 characters.
  summary: string
}

// An outcome label's note, at most 200 characters.
export const OUTCOME_NOTES: Readonly<Record<SessionOutcome, string>> = {
  'done': 'delivered and tested',
  'partly done': 'first part delivered; the rest left open',
  'handed off': 'change written; the developer takes it from here',
  'blocked': 'stopped by something outside the code',
  'failed': 'the change did not fix the problem',
  'abandoned': 'dropped before the fix was finished',
  'no task': 'a question, answered',
  'unclear': 'the review ended without a clear verdict',
}

// Features in `shop`, bug fixes and debugging in `billing`, as the story has it.
export const WORK: Record<ProjectName, readonly IWorkItem[]> = {
  shop: [
    {
      title: 'add a discount code field to checkout',
      goal: 'build a feature',
      outcomes: ['done', 'partly done'],
      summary: 'Adds a discount code field to the checkout form and caps a code at the full price.',
    },
    {
      title: 'keep the saved cart after sign-in',
      goal: 'build a feature',
      outcomes: ['done', 'handed off', 'abandoned'],
      summary: 'Keeps the saved cart when a guest signs in, instead of replacing it with the account cart.',
    },
    {
      title: 'review the checkout form changes',
      goal: 'review',
      outcomes: ['done', 'unclear'],
      summary: 'Reviews the checkout form changes for missing tests and unclear names.',
    },
    {
      title: 'split the cart total into smaller functions',
      goal: 'refactor, migrate or clean up',
      outcomes: ['done', 'partly done'],
      summary: 'Splits the cart total into smaller functions without changing what it returns.',
    },
    {
      title: 'plan the gift card flow',
      goal: 'plan or specify',
      outcomes: ['done', 'handed off'],
      summary: 'Plans how a gift card is bought, sent by email and taken at checkout.',
    },
    {
      title: 'ask what the cart badge counts',
      goal: 'no task',
      outcomes: ['no task'],
      summary: 'Asks whether the cart badge counts items or lines.',
    },
  ],
  billing: [
    {
      title: 'fix rounding in invoice totals',
      goal: 'fix a bug',
      outcomes: ['done', 'failed', 'blocked'],
      summary: 'Fixes invoice totals that round half a cent the wrong way.',
    },
    {
      title: 'find why the tax total drifts by a cent',
      goal: 'debug or diagnose',
      outcomes: ['done', 'blocked', 'unclear'],
      summary: 'Traces why the tax total drifts by a cent on some invoices.',
    },
    {
      title: 'fix the late fee applied twice',
      goal: 'fix a bug',
      outcomes: ['done', 'partly done', 'abandoned'],
      summary: 'Fixes the late fee being added twice to an invoice paid after its due date.',
    },
    {
      title: 'check that refunds keep the original currency',
      goal: 'verify behaviour',
      outcomes: ['done', 'failed'],
      summary: 'Checks that a refund is paid in the currency of the original charge.',
    },
    {
      title: 'release billing 2.3.0',
      goal: 'ship and operate',
      outcomes: ['done', 'blocked'],
      summary: 'Releases billing 2.3.0: release notes, a tag and the push.',
    },
  ],
}
