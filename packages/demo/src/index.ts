export { buildDemo, type IBuildOptions, type IBuiltDemo } from './build/build-demo.js'
export { checkDemo, type DemoRule, type IDemoFinding } from './check/check-demo.js'
export { startDemo, type IStartDemoOptions, type IStartedDemo } from './start/start-demo.js'
export { scanText, type IScanFinding, type IScanOptions, type ScanRule } from './check/scan-text.js'
export { DEMO_ERROR_CODES } from './errors.js'
// The engine's labelling tasks, with each field's vocabulary and each task's version, for the web tests that hold the
// small set to its coverage contract: the web app may not import the engine.
export { LABEL_TASKS, type ILabelTaskInfo } from '@log-book/engine'
export { planLabels } from './plan/labels.js'
export { sealedEnvironment } from './sealed-environment.js'
export { planDataset } from './plan/planner.js'
export { scriptPlan } from './plan/scripts.js'
export { validateLabelPlan } from './plan/validate.js'
export type {
  DemoSize,
  ILabelPlan,
  IPlan,
  IPlanCorpus,
  IPlanInputs,
  IPlannedLabel,
  IPlannedRun,
  IPlannedRunTask,
  IPlannedSession,
  IPlannedTurn,
  IWriterDeclaration,
  IWriterScripts,
  LabelsVariant,
  PlannedOrigin,
} from './plan/types.js'
