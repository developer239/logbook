import type { SessionGoal, SessionOutcome } from '@log-book/engine'
import type { ProjectName } from './projects.js'

export interface IWorkItem {
  title: string
  goal: SessionGoal
  // The outcomes a session on this item may end with.
  outcomes: readonly SessionOutcome[]
}

// Features in `shop`, bug fixes and debugging in `billing`, as the story has it.
export const WORK: Record<ProjectName, readonly IWorkItem[]> = {
  shop: [
    { title: 'add a discount code field to checkout', goal: 'build a feature', outcomes: ['done', 'partly done'] },
    {
      title: 'keep the saved cart after sign-in',
      goal: 'build a feature',
      outcomes: ['done', 'handed off', 'abandoned'],
    },
    { title: 'review the checkout form changes', goal: 'review', outcomes: ['done', 'unclear'] },
    {
      title: 'split the cart total into smaller functions',
      goal: 'refactor, migrate or clean up',
      outcomes: ['done', 'partly done'],
    },
    { title: 'plan the gift card flow', goal: 'plan or specify', outcomes: ['done', 'handed off'] },
    { title: 'ask what the cart badge counts', goal: 'no task', outcomes: ['no task'] },
  ],
  billing: [
    { title: 'fix rounding in invoice totals', goal: 'fix a bug', outcomes: ['done', 'failed', 'blocked'] },
    {
      title: 'find why the tax total drifts by a cent',
      goal: 'debug or diagnose',
      outcomes: ['done', 'blocked', 'unclear'],
    },
    { title: 'fix the late fee applied twice', goal: 'fix a bug', outcomes: ['done', 'partly done', 'abandoned'] },
    {
      title: 'check that refunds keep the original currency',
      goal: 'verify behaviour',
      outcomes: ['done', 'failed'],
    },
    { title: 'release billing 2.3.0', goal: 'ship and operate', outcomes: ['done', 'blocked'] },
  ],
}
