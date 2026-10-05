import type { SessionOrigin as WarehouseSessionOrigin } from '@log-book/warehouse'

// A model answers with a value's index, so the order of each list is the contract: a new value goes at the end with
// its task's version raised, and a removal renumbers the rest and raises it too.

export const SHELL_PURPOSES = [
  'read or search code',
  'check a change (format, lint, typecheck, build)',
  'run tests',
  'inspect git state',
  'change git (commit, push, branch, rebase)',
  'pull request or CI',
  'wait for something',
  'edit files',
  'write files',
  'inspect a data file (json, yaml, logs)',
  'run a script or program',
  'install or set up',
  'query a service (http, database, cloud, docker)',
  'other',
] as const
export type ShellPurpose = (typeof SHELL_PURPOSES)[number]

export const SHELL_FAILURES = [
  'none',
  'command mistake',
  'real result',
  'environment',
  'permission',
  'timeout',
] as const
export type ShellFailure = (typeof SHELL_FAILURES)[number]

export const SESSION_INITIATORS = ['human', 'agent'] as const
export type SessionInitiator = (typeof SESSION_INITIATORS)[number]

export const SESSION_GOALS = [
  'build a feature',
  'fix a bug',
  'refactor, migrate or clean up',
  'review',
  'explore the codebase',
  'research outside the codebase',
  'debug or diagnose',
  'plan or specify',
  'verify behaviour',
  'ship and operate',
  'set up environment or session',
  'project admin',
  'writing',
  'extract or transform data',
  'harness test or probe',
  'no task',
  'other',
] as const
export type SessionGoal = (typeof SESSION_GOALS)[number]

export const SECOND_GOALS = ['none', ...SESSION_GOALS] as const
export type SecondGoal = (typeof SECOND_GOALS)[number]

export const SESSION_OUTCOMES = [
  'done',
  'partly done',
  'handed off',
  'blocked',
  'failed',
  'abandoned',
  'no task',
  'unclear',
] as const
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number]

export const TOOL_FAILURE_CAUSES = [
  'missing target',
  'edit mismatch',
  'invalid call',
  'auth',
  'service unreachable',
  'rate limited',
  'rejected',
  'aborted',
  'output too large',
  'environment',
  'tool fault',
  'other',
] as const
export type ToolFailureCause = (typeof TOOL_FAILURE_CAUSES)[number]

export const TOOL_RECOVERIES = ['recovered', 'not recovered'] as const
export type ToolRecovery = (typeof TOOL_RECOVERIES)[number]

export const PROMPT_ACTS = ['task', 'continue', 'question', 'answer', 'report', 'other'] as const
export type PromptAct = (typeof PROMPT_ACTS)[number]

export const REACTIONS = ['correction', 'pushback', 'clarification', 'redirect', 'praise', 'teaching'] as const
export type Reaction = (typeof REACTIONS)[number]

export const REACTION_ABOUT = ['last turn', 'earlier turn'] as const
export type ReactionAbout = (typeof REACTION_ABOUT)[number]

export const REACTION_TARGETS = [
  'design',
  'scope',
  'style',
  'process',
  'verification',
  'tools',
  'communication',
  'other',
] as const
export type ReactionTarget = (typeof REACTION_TARGETS)[number]

export const REACTION_REACH = ['once', 'project', 'everywhere'] as const
export type ReactionReach = (typeof REACTION_REACH)[number]

export const REPLY_CODES = [
  'none',
  'pushback',
  'corrects',
  'holds',
  'reverses',
  'caves',
  'asks',
  'permission',
  'verified',
  'unverified',
  'admits',
  'options',
  'discloses',
] as const
export type ReplyCode = (typeof REPLY_CODES)[number]

// The warehouse's session origins; no task labels them, the read commands filter on them.
export const SESSION_ORIGINS = [
  'interactive',
  'scripted',
  'subagent',
] as const satisfies readonly WarehouseSessionOrigin[]
export type SessionOrigin = (typeof SESSION_ORIGINS)[number]
