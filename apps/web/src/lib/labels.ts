import { countBy } from './lists'
import type { ServerState } from './plugins'

export const UNLABELLED = 'Not labelled yet'

export const UNLABELLED_INLINE = UNLABELLED.toLowerCase()

export const UNTITLED = 'Untitled conversation'

interface IHarness {
  name: string
  defaultAgent: string
  alias: string
}

const HARNESSES: Readonly<Record<string, IHarness>> = {
  'claude-code': { name: 'Claude Code', defaultAgent: 'Claude', alias: 'claude' },
  'opencode': { name: 'OpenCode', defaultAgent: 'OpenCode', alias: 'opencode' },
}

export const harnessName = (harness: string): string => HARNESSES[harness]?.name ?? harness

export const harnessAgent = (harness: string): string => HARNESSES[harness]?.defaultAgent ?? harness

export const harnessOfFilter = (value: string): string =>
  Object.entries(HARNESSES).find(([, harness]) => harness.alias === value.toLowerCase())?.[0] ?? value

export const STARTED_BY = { me: 'me', agent: 'an agent', script: 'a script' } as const

export type StartedBy = keyof typeof STARTED_BY

export const countStartedBy = (items: readonly { startedBy: StartedBy }[]): Record<StartedBy, number> => {
  const counts = countBy(items, (item) => item.startedBy)
  return { me: counts.get('me') ?? 0, agent: counts.get('agent') ?? 0, script: counts.get('script') ?? 0 }
}

export const SERVER_STATES: Readonly<Record<ServerState, string>> = {
  'connected': '',
  'needs-sign-in': 'needed a sign-in',
  'failed': 'failed at the start',
  'connecting': 'still connecting at the start',
}

// Keyed by a non-shell call's `cause` label.
const CAUSES: Readonly<Record<string, string>> = {
  'missing target': 'Guessed a wrong path or name',
  'edit mismatch': "Edit didn't match the file",
  'invalid call': 'Called the tool wrong',
  'auth': 'Credentials',
  'service unreachable': 'Service unreachable',
  'rate limited': 'Rate limited',
  'rejected': 'Blocked by permission',
  'aborted': 'Stopped before finishing',
  'output too large': 'Output too large',
  'environment': 'Environment',
  'tool fault': 'Tool bug',
  'other': 'Other',
}

// Keyed by a shell call's `failure` label. A real result (a failing test, grep
// finding nothing) and a normal non-zero exit are not problems, so they have no
// cause here.
const SHELL_CAUSES: Readonly<Record<string, string>> = {
  'command mistake': 'Called the tool wrong',
  'environment': 'Environment',
  'permission': 'Blocked by permission',
  'timeout': 'Timed out',
}

export const NOT_A_PROBLEM = new Set(['real result', 'none'])

export const TOOL_BUG = 'Tool bug'

export const causeOf = (family: string, label: string | null): string | null => {
  if (label === null) {
    return UNLABELLED
  }

  if (family === 'shell') {
    return NOT_A_PROBLEM.has(label) ? null : (SHELL_CAUSES[label] ?? UNLABELLED)
  }

  return CAUSES[label] ?? UNLABELLED
}

export interface ICauseLabels {
  shell: string[]
  other: string[]
}

export const labelsOfCause = (cause: string): ICauseLabels => ({
  shell: Object.entries(SHELL_CAUSES)
    .filter(([, shown]) => shown === cause)
    .map(([label]) => label),
  other: Object.entries(CAUSES)
    .filter(([, shown]) => shown === cause)
    .map(([label]) => label),
})

export const KNOWN_LABELS: ICauseLabels = {
  shell: [...Object.keys(SHELL_CAUSES), ...NOT_A_PROBLEM],
  other: Object.keys(CAUSES),
}

const GOALS: Readonly<Record<string, string>> = {
  'build a feature': 'Building features',
  'fix a bug': 'Fixing bugs',
  'refactor, migrate or clean up': 'Refactoring',
  'review': 'Review',
  'explore the codebase': 'Exploring code',
  'research outside the codebase': 'Outside research',
  'debug or diagnose': 'Debugging',
  'plan or specify': 'Planning',
  'verify behaviour': 'Verifying',
  'ship and operate': 'Shipping',
  'set up environment or session': 'Setting up',
  'project admin': 'Project admin',
  'writing': 'Writing',
  'extract or transform data': 'Data extraction',
  'harness test or probe': 'Self-tests',
  'no task': 'No task',
  'other': 'Other',
}

export const goalName = (goal: string | null): string => (goal === null ? UNLABELLED : (GOALS[goal] ?? goal))

export const NOT_WORK = new Set(['no task', 'harness test or probe'])

const OUTCOME_STATUS: Readonly<Record<string, string>> = {
  'done': 'good',
  'partly done': 'slow',
  'handed off': '',
  'blocked': 'problem',
  'failed': 'problem',
  'abandoned': 'hollow',
  'no task': 'hollow',
  'unclear': 'hollow',
}

export const outcomeStatus = (outcome: string | null): string =>
  outcome === null ? 'hollow' : (OUTCOME_STATUS[outcome] ?? 'hollow')

// The kinds of reaction a prompt can have to the agent, the most pressing first, with the Status tone of each.
const REACTION_STATUS: readonly (readonly [string, string])[] = [
  ['correction', 'problem'],
  ['pushback', 'slow'],
  ['clarification', 'slow'],
  ['redirect', 'hollow'],
  ['teaching', 'hollow'],
  ['praise', 'good'],
]

export const reactionStatus = (reaction: string): string =>
  REACTION_STATUS.find(([kind]) => kind === reaction)?.[1] ?? 'hollow'

const pressureRank = (reaction: string): number => REACTION_STATUS.findIndex(([kind]) => kind === reaction)

export const byPressure = (reactions: readonly string[]): string[] =>
  [...new Set(reactions)].toSorted((left, right) => pressureRank(left) - pressureRank(right))

export const DIDNT_FINISH = ['blocked', 'failed', 'abandoned'] as const

export const purposeName = (purpose: string | null): string | null =>
  purpose === null ? null : purpose.replace(/\s*\([^)]*\)$/u, '')
