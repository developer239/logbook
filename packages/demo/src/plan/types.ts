import type { ICommandFile, ISessionScript } from '@log-book/adapter-api/source-writer'
import type {
  LabelRecordType,
  LabelTaskName,
  PromptAct,
  Reaction,
  ReactionAbout,
  ReactionReach,
  ReactionTarget,
  ReplyCode,
  SessionGoal,
  SessionOutcome,
} from '@log-book/engine'
import type { ICommandCorpus } from '../corpus/commands.js'
import type { IModelRates } from '../corpus/models.js'
import type { IProject, ProjectName } from '../corpus/projects.js'
import type { IPromptCorpus } from '../corpus/prompts.js'
import type { IReplyCorpus } from '../corpus/replies.js'
import type { IShapeCorpus, ShapeName, SubagentTaskName } from '../corpus/shapes.js'
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
  outcomeNotes: Readonly<Record<SessionOutcome, string>>
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
  // The labelling model, the build's --model; null for the engine's default.
  model: string | null
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
  // The developer's reactions each prompt step carries, by its key; a prompt without any is left out.
  reactions: Record<string, IPlannedReaction[]>
  // The reply codes of the agent's last text before each next prompt in an interactive session, by its reply key.
  replies: Record<string, IPlannedReply>
  // The labels each call step stands for, by its key.
  calls: Record<string, ICallLabels>
  // The task each started session was started with, by its session key.
  subagents: Record<string, SubagentTaskName>
}

export interface IPlannedReaction {
  // From 1, with no gap, in the prompt's order.
  number: number
  reaction: Reaction
  about: ReactionAbout
  target: ReactionTarget
  reach: ReactionReach
  // Call step keys of the turn before the prompt.
  steps: string[]
}

export interface IPlannedReply {
  codes: ReplyCode[]
  // The words of the reply a quote copies, or null where its template marks none.
  quote: string | null
}

export interface ICallLabels {
  shell: IShellLabels | null
  failure: IFailureLabels | null
}

// A model label as the warehouse will hold it, its record named by plan key: a session's or a step's, or
// `<prompt key>#<n>` for a reaction.
export interface IPlannedLabel {
  recordKey: string
  recordType: LabelRecordType
  labeller: string
  version: number
  name: string
  value: string
  labelledAt: number
  // The number of the labelling run that writes it.
  run: number
}

export interface IPlannedRunTask {
  task: LabelTaskName
  version: number
  planned: number
  done: number
}

// A labelling run as a user's own command would have recorded it.
export interface IPlannedRun {
  number: number
  // The command it stands for.
  command: string
  model: string
  pid: number
  startedAt: number
  endedAt: number
  outcome: 'ok'
  error: null
  tasks: IPlannedRunTask[]
}

export interface ILabelPlan {
  labels: IPlannedLabel[]
  runs: IPlannedRun[]
}
