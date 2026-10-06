import type { IBuiltDemo } from '@log-book/demo'
import { NOT_A_PROBLEM, type StartedBy } from '../src/lib/labels'
import { parseRange, type IRange } from '../src/lib/range'

// What a demo build planned, read the way a test needs it: every script and step by session, and the record id the
// writers gave each plan key. Tests take their expected counts, titles and ids from here, never from copied numbers.

export type TScript = IBuiltDemo['plan']['writers'][number]['scripts'][number]
export type TStep = TScript['steps'][number]
export type TCallStep = Extract<TStep, { kind: 'call' }>
export type TPlannedSession = IBuiltDemo['plan']['plan']['sessions'][number]
type TCallLabels = IBuiltDemo['plan']['writers'][number]['calls'][string]

// A step with the session it belongs to.
export interface IPlacedStep<TKind extends TStep = TStep> {
  sessionKey: string
  step: TKind
}

// The record id the writers gave a plan key.
export const idOf = (demo: IBuiltDemo, key: string): string => {
  const id = demo.plan.ids[key]
  if (id === undefined) {
    throw new Error(`The demo plan gives the key ${key} no record id`)
  }
  return id
}

// Every session script, the sessions a spawn step started included, in plan order.
const scriptsOf = (demo: IBuiltDemo): TScript[] => {
  const scripts: TScript[] = []
  const walk = (script: TScript): void => {
    scripts.push(script)
    for (const step of script.steps) {
      if (step.kind === 'spawn') {
        walk(step.child)
      }
    }
  }
  for (const writer of demo.plan.writers) {
    for (const script of writer.scripts) {
      walk(script)
    }
  }
  return scripts
}

export const stepsOf = (demo: IBuiltDemo): IPlacedStep[] =>
  scriptsOf(demo).flatMap((script) => script.steps.map((step) => ({ sessionKey: script.key, step })))

// The steps a tool call row stands for: calls, the spawns that start a session and the skill loads.
export const callRowsOf = (demo: IBuiltDemo): IPlacedStep<Extract<TStep, { kind: 'call' | 'spawn' | 'skill' }>>[] =>
  stepsOf(demo).flatMap((placed) =>
    placed.step.kind === 'call' || placed.step.kind === 'spawn' || placed.step.kind === 'skill'
      ? [{ sessionKey: placed.sessionKey, step: placed.step }]
      : []
  )

export const callsOf = (demo: IBuiltDemo): IPlacedStep<TCallStep>[] =>
  stepsOf(demo).flatMap((placed) =>
    placed.step.kind === 'call' ? [{ sessionKey: placed.sessionKey, step: placed.step }] : []
  )

// A call the warehouse records as failed: one that failed, or one the human refused.
export const isFailed = (step: TCallStep): boolean => step.status === 'error' || step.status === 'rejected'

// A session's own steps, without those of the sessions it started.
export const ownStepsOf = (demo: IBuiltDemo, key: string): TStep[] =>
  stepsOf(demo)
    .filter((placed) => placed.sessionKey === key)
    .map((placed) => placed.step)

export const firstPromptOf = (demo: IBuiltDemo, key: string): Extract<TStep, { kind: 'prompt' }> => {
  const prompt = ownStepsOf(demo, key).find((step) => step.kind === 'prompt')
  if (prompt === undefined) {
    throw new Error(`${key} plans no prompt`)
  }
  return prompt
}

// The prompt whose turn a step is in: the last one before it.
export const promptBefore = (demo: IBuiltDemo, key: string, stepKey: string): string => {
  const steps = ownStepsOf(demo, key)
  const prompt = steps
    .slice(
      0,
      steps.findIndex((step) => step.key === stepKey)
    )
    .findLast((step) => step.kind === 'prompt')
  if (prompt === undefined) {
    throw new Error(`No prompt comes before ${stepKey}`)
  }
  return prompt.key
}

// The first top-level conversation whose own steps hold every kind of step asked for.
export const sessionWith = (demo: IBuiltDemo, ...wanted: ((step: TStep) => boolean)[]): string => {
  const found = demo.plan.plan.sessions.find(
    (planned) => planned.parentKey === null && wanted.every((isWanted) => ownStepsOf(demo, planned.key).some(isWanted))
  )
  if (found === undefined) {
    throw new Error('The small set plans no conversation with those steps')
  }
  return found.key
}

// The harness that recorded a session, by the harness its record id names.
export const harnessOf = (demo: IBuiltDemo, key: string): string => idOf(demo, key).split(':')[0] ?? ''

export const plannedSession = (demo: IBuiltDemo, key: string): TPlannedSession => {
  const session = demo.plan.plan.sessions.find((planned) => planned.key === key)
  if (session === undefined) {
    throw new Error(`The demo plan has no session ${key}`)
  }
  return session
}

// A call's family as the warehouse records it: an MCP call's under its server.
export const familyOf = (step: TCallStep): string => (step.family === 'mcp' ? `mcp:${step.server ?? ''}` : step.family)

// The newest value the planned model labels give a record's field; null where none is planned.
export const plannedLabel = (demo: IBuiltDemo, recordKey: string, name: string): string | null =>
  demo.plan.labels.labels
    .filter((label) => label.recordKey === recordKey && label.name === name)
    .toSorted((left, right) => right.labelledAt - left.labelledAt)[0]?.value ?? null

const callLabelsOf = (demo: IBuiltDemo, key: string): TCallLabels | undefined =>
  demo.plan.writers.map((written) => written.calls[key]).find((labels) => labels !== undefined)

// What a failed call's failure reads by on the pages: a shell call's model `failure`, another call's cause as the sync's
// rules settle it, else as a model labelled it.
export const failureLabelOf = (demo: IBuiltDemo, step: TCallStep): string | null => {
  if (step.family === 'shell') {
    return plannedLabel(demo, step.key, 'failure')
  }
  const failure = callLabelsOf(demo, step.key)?.failure
  return failure?.isRuleSettled === true ? failure.cause : plannedLabel(demo, step.key, 'cause')
}

// The reactions a prompt holds as the pages read them: those of the labeller and version of its newest `act`, in order.
export const reactionsOf = (demo: IBuiltDemo, promptKey: string): string[] => {
  const { labels } = demo.plan.labels
  const act = labels
    .filter((label) => label.recordKey === promptKey && label.name === 'act')
    .toSorted((left, right) => right.labelledAt - left.labelledAt)[0]
  if (act === undefined) {
    return []
  }
  return labels
    .filter(
      (label) =>
        label.recordType === 'reaction' &&
        label.recordKey.startsWith(`${promptKey}#`) &&
        label.name === 'reaction' &&
        label.labeller === act.labeller &&
        label.version === act.version
    )
    .toSorted((left, right) => Number(left.recordKey.split('#')[1]) - Number(right.recordKey.split('#')[1]))
    .map((label) => label.value)
}

// A shell call's purpose as the sync's rules settle it, else as a model labelled it; null for another call.
export const purposeLabelOf = (demo: IBuiltDemo, step: TCallStep): string | null => {
  const shell = step.family === 'shell' ? callLabelsOf(demo, step.key)?.shell : null
  if (shell === undefined || shell === null) {
    return null
  }
  return shell.isRuleSettled ? shell.purpose : plannedLabel(demo, step.key, 'purpose')
}

export interface IFailedCall {
  id: string
  sessionKey: string
  step: TCallStep
  family: string
  label: string | null
}

// Every call the warehouse records as failed, with the label its failure reads by.
export const failedCallsOf = (demo: IBuiltDemo): IFailedCall[] =>
  callsOf(demo)
    .filter((placed) => isFailed(placed.step))
    .map((placed) => ({
      id: idOf(demo, placed.step.key),
      sessionKey: placed.sessionKey,
      step: placed.step,
      family: familyOf(placed.step),
      label: failureLabelOf(demo, placed.step),
    }))

// A failure that is the shell's real result, not a problem.
export const isRealResult = (call: { family: string; label: string | null }): boolean =>
  call.family === 'shell' && call.label !== null && NOT_A_PROBLEM.has(call.label)

const STARTED_BY: Readonly<Record<TPlannedSession['origin'], StartedBy>> = {
  interactive: 'me',
  subagent: 'agent',
  scripted: 'script',
}

export const startedByOf = (session: TPlannedSession): StartedBy => STARTED_BY[session.origin]

export const scriptOf = (demo: IBuiltDemo, key: string): TScript => {
  const script = scriptsOf(demo).find((candidate) => candidate.key === key)
  if (script === undefined) {
    throw new Error(`The demo plan has no script ${key}`)
  }
  return script
}

// A conversation's title as the pages show it: its own, else the opening of its first prompt.
export const titleOf = (demo: IBuiltDemo, key: string): string | null => {
  const opening = scriptOf(demo, key).steps.find((step) => step.kind === 'prompt')
  return plannedSession(demo, key).title ?? opening?.text.slice(0, 90) ?? null
}

// The whole of the set's time, as the pages read it on the build's anchor.
export const allTime = (demo: IBuiltDemo): IRange => parseRange(new URLSearchParams('range=all'), demo.plan.plan.anchor)
