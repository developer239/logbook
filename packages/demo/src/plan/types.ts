import type { ICommandFile, ISessionScript } from '@log-book/adapter-api/source-writer'
import type { PromptAct, SessionGoal, SessionOutcome } from '@log-book/engine'
import type { ICommandCorpus } from '../corpus/commands.js'
import type { IModelRates } from '../corpus/models.js'
import type { IProject, ProjectName } from '../corpus/projects.js'
import type { IPromptCorpus } from '../corpus/prompts.js'
import type { IReplyCorpus } from '../corpus/replies.js'
import type { IShapeCorpus, ShapeName } from '../corpus/shapes.js'
import type { IFailureLabels, IShellLabels, IToolCorpus } from '../corpus/tools.js'
import type { IWorkItem } from '../corpus/work.js'

export type DemoSize = 'small'

// `none` plans no model labels: every "not labelled yet" state.
export type LabelsVariant = 'all' | 'none'

// What a source writer declares, as plain lists: the planner gives it sessions by these and by its place in the list,
// never by a harness id.
export interface IWriterDeclaration {
  capabilities: readonly string[]
  families: readonly string[]
  // The model ids its harness records, from models.ts.
  models: readonly string[]
}

export interface IPlanCorpus {
  projects: Readonly<Record<ProjectName, IProject>>
  work: Readonly<Record<ProjectName, readonly IWorkItem[]>>
  shapes: IShapeCorpus
  prompts: IPromptCorpus
  replies: IReplyCorpus
  tools: IToolCorpus
  commands: ICommandCorpus
  rates: Readonly<Record<string, IModelRates>>
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
  // The shapes.ts shape of its turns; a started session takes its parent's and follows the task it was started with.
  shape: ShapeName
  // The session whose shell call started this scripted one; the warehouse records no link for it.
  startedFrom: string | null
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

// What one writer is given: its command files and its top-level session scripts, each started session inside the spawn
// step that starts it.
export interface IWriterScripts {
  commandFiles: ICommandFile[]
  scripts: ISessionScript[]
  // The act of each prompt step, by its key.
  acts: Record<string, PromptAct>
  // The labels each call step stands for, by its key.
  calls: Record<string, ICallLabels>
}

export interface ICallLabels {
  shell: IShellLabels | null
  failure: IFailureLabels | null
}
