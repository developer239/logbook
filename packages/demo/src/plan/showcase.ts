import { HOUR_MS } from './calendar.js'
import { has, spanOf, TOP_LEVEL_AGENT } from './session-planner.js'
import type { IPlanInputs, IPlannedSession, IPlannedTurn } from './types.js'

const SECOND_MS = 1000

const timed = (start: number, times: readonly { at: number; seconds: number }[]): IPlannedTurn[] =>
  times.map(({ at, seconds }) => ({ start: start + at * SECOND_MS, end: start + (at + seconds) * SECOND_MS }))

// The showcase conversation of showcase.ts and the session it starts, in the first writer that declares what it needs,
// at times that move only with the anchor; it draws nothing from the seed.
export const planShowcase = (inputs: IPlanInputs): IPlannedSession[] => {
  const { showcase, work, projects } = inputs.corpus
  const writer = inputs.writers.findIndex((declaration) =>
    showcase.capabilities.every((capability) => declaration.capabilities.includes(capability))
  )
  if (writer === -1) {
    throw new Error(`No writer declares ${showcase.capabilities.join(', ')}, which the showcase conversation needs`)
  }
  const item = work[showcase.project].find((candidate) => candidate.title === showcase.work)
  if (item === undefined || !item.outcomes.includes(showcase.outcome)) {
    throw new Error(`No work item ${showcase.work} in ${showcase.project} that may end ${showcase.outcome}`)
  }
  if (!projects[showcase.project].branches.includes(showcase.branch)) {
    throw new Error(`No branch ${showcase.branch} in ${showcase.project}`)
  }
  const host = showcase.turns[showcase.subagent.turn - 1]
  if (host === undefined) {
    throw new Error(`The showcase conversation has no turn ${String(showcase.subagent.turn)}`)
  }

  const start = inputs.anchor - showcase.startHoursBeforeAnchor * HOUR_MS
  const turns = timed(start, showcase.turns)
  const isLabelled = inputs.labels === 'all'
  const key = `${showcase.project}/showcase`
  const session: IPlannedSession = {
    key,
    writer,
    project: showcase.project,
    origin: 'interactive',
    parentKey: null,
    ...spanOf(turns),
    title: item.title,
    gitBranch: showcase.branch,
    agent: has(inputs.writers[writer], 'session-agent') ? TOP_LEVEL_AGENT : null,
    work: item.title,
    shape: 'showcase',
    startedFrom: null,
    goal: isLabelled ? item.goal : null,
    outcome: isLabelled ? showcase.outcome : null,
    turns,
  }
  const childTurns = timed(start + (host.at + showcase.subagent.after) * SECOND_MS, showcase.subagent.times)
  const child: IPlannedSession = {
    ...session,
    key: `${key}/sub1`,
    origin: 'subagent',
    parentKey: key,
    ...spanOf(childTurns),
    title: null,
    agent: null,
    goal: null,
    outcome: null,
    turns: childTurns,
  }

  return [session, child]
}
