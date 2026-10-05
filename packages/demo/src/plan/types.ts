import type { SessionGoal, SessionOutcome } from '@log-book/engine'
import type { IProject, ProjectName } from '../corpus/projects.js'
import type { IWorkItem } from '../corpus/work.js'

export type DemoSize = 'small'

// `none` plans no model labels: every "not labelled yet" state.
export type LabelsVariant = 'all' | 'none'

// What a source writer declares, as plain lists: the planner gives it sessions by these and by its place in the list,
// never by a harness id.
export interface IWriterDeclaration {
  capabilities: readonly string[]
  families: readonly string[]
}

export interface IPlanCorpus {
  projects: Readonly<Record<ProjectName, IProject>>
  work: Readonly<Record<ProjectName, readonly IWorkItem[]>>
}

export interface IPlanInputs {
  size: DemoSize
  seed: number
  // Epoch milliseconds; every planned time is the anchor minus an offset.
  anchor: number
  labels: LabelsVariant
  // The labeller of every planned label.
  model: string
  corpus: IPlanCorpus
  writers: readonly IWriterDeclaration[]
}

export interface IPlannedTurn {
  start: number
  end: number
}

export type PlannedOrigin = 'interactive' | 'scripted' | 'subagent'

export interface IPlannedSession {
  key: string
  // The writer's place in the demo's list of writers.
  writer: number
  project: ProjectName
  origin: PlannedOrigin
  parentKey: string | null
  start: number
  end: number
  title: string | null
  gitBranch: string | null
  agent: string | null
  // The item of work.ts the session works on; a started session works on its parent's.
  work: string
  goal: SessionGoal | null
  outcome: SessionOutcome | null
  turns: IPlannedTurn[]
}

// Plain data only, so `plan.json` reads back as an equal value.
export interface IPlan {
  size: DemoSize
  seed: number
  anchor: number
  labels: LabelsVariant
  // The labeller of the planned labels; null when none are planned.
  labelModel: string | null
  days: number
  // In plan order: each top-level session followed by the sessions it started.
  sessions: IPlannedSession[]
}
