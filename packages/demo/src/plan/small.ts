import type { SessionOutcome } from '@log-book/engine'
import type { ProjectName } from '../corpus/projects.js'
import type { ShapeName } from '../corpus/shapes.js'

// When a session that ends in the 48 hours before the anchor ends: within the hour before it, or about a day before.
export type RecentEnd = 'last-hour' | 'last-day'

export interface ISessionSpec {
  // The writer's place in the demo's list: Claude Code's writer first, OpenCode's second.
  writer: number
  project: ProjectName
  // The title of a work.ts item of the project.
  work: string
  // A shapes.ts shape that fits the item's goal.
  shape: ShapeName
  // Null for a session that ends in the 48 hours before the anchor: it stays unlabelled.
  outcome: SessionOutcome | null
  recentEnd?: RecentEnd
  // Needs the writer's `scripted`.
  isScripted?: boolean
  // Its first turn runs the writer's scripted session through a shell call, which starts it at the call's time.
  runsScripted?: boolean
  isUntitled?: boolean
  // A session it starts, and whether that one starts another (needs `nested-subagent`).
  spawn?: { isNested: boolean }
  // An idle stretch of more than 10 minutes between its first two turns.
  hasIdleGap?: boolean
}

// The 14 top-level sessions of the small set. Fixed, so the coverage holds for every seed: 8 in the first writer (1
// scripted, run from another's shell call) and 6 in the second, 3 subagents in the first (1 started inside another) and 2 child sessions in the
// second, and among the 12 labelled sessions 6 goals and all 8 outcomes. The seed decides the days, the hours and
// the turns.
export const SMALL_SESSIONS: readonly ISessionSpec[] = [
  {
    writer: 0,
    project: 'shop',
    work: 'add a discount code field to checkout',
    shape: 'feature through a subagent',
    outcome: 'done',
    spawn: { isNested: true },
    hasIdleGap: true,
  },
  {
    writer: 0,
    project: 'shop',
    work: 'keep the saved cart after sign-in',
    shape: 'feature that runs a question',
    outcome: 'handed off',
    runsScripted: true,
  },
  {
    writer: 0,
    project: 'shop',
    work: 'review the checkout form changes',
    shape: 'review through a subagent',
    outcome: 'unclear',
    spawn: { isNested: false },
  },
  {
    writer: 0,
    project: 'shop',
    work: 'split the cart total into smaller functions',
    shape: 'refactor in steps',
    outcome: 'partly done',
  },
  {
    writer: 0,
    project: 'shop',
    work: 'ask what the cart badge counts',
    shape: 'quick question',
    outcome: 'no task',
    isScripted: true,
  },
  {
    writer: 0,
    project: 'billing',
    work: 'fix the late fee applied twice',
    shape: 'tracked bug fix',
    outcome: 'abandoned',
  },
  {
    writer: 0,
    project: 'shop',
    work: 'add a discount code field to checkout',
    shape: 'feature with tests',
    outcome: 'done',
    isUntitled: true,
  },
  {
    writer: 0,
    project: 'shop',
    work: 'plan the gift card flow',
    shape: 'plan a flow',
    outcome: null,
    recentEnd: 'last-hour',
  },
  {
    writer: 1,
    project: 'billing',
    work: 'fix rounding in invoice totals',
    shape: 'bug fix with tests',
    outcome: 'failed',
  },
  {
    writer: 1,
    project: 'billing',
    work: 'find why the tax total drifts by a cent',
    shape: 'debug through a subagent',
    outcome: 'blocked',
    spawn: { isNested: false },
  },
  {
    writer: 1,
    project: 'billing',
    work: 'fix rounding in invoice totals',
    shape: 'fix through a subagent',
    outcome: 'done',
    spawn: { isNested: false },
  },
  {
    writer: 1,
    project: 'billing',
    work: 'find why the tax total drifts by a cent',
    shape: 'debug with a helper',
    outcome: 'done',
    isUntitled: true,
  },
  {
    writer: 1,
    project: 'shop',
    work: 'split the cart total into smaller functions',
    shape: 'refactor in steps',
    outcome: 'done',
  },
  {
    writer: 1,
    project: 'billing',
    work: 'release billing 2.3.0',
    shape: 'release with a command',
    outcome: null,
    recentEnd: 'last-day',
  },
]

export const SMALL_DAYS = 21
// The last day an older session may fall on, so it ends before the 48 hours before the anchor whatever the anchor's
// hour: day 17 of 21 ends at least two whole days before the anchor's day starts.
export const SMALL_LAST_OLDER_DAY = 17
// Of the older days, how many hold a session, and how many of those hold two.
export const SMALL_ACTIVE_DAYS = 9
export const SMALL_DOUBLE_DAYS = 3
// The keys of the two recent sessions, fixed so no key depends on the anchor.
export const SMALL_RECENT_DAYS: Readonly<Record<RecentEnd, number>> = { 'last-day': 19, 'last-hour': 20 }
