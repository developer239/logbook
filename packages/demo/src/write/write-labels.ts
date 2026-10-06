import { LogBookError } from '@log-book/core'
import { LABEL_TASKS, type LabelTaskName } from '@log-book/engine'
import { WarehouseStore, type ILabelRecord } from '@log-book/warehouse'
import { DEMO_ERROR_CODES } from '../errors.js'
import type { IDemoPlan, IPlannedLabel } from '../plan/types.js'

const RULES_LABELLER = 'rules'
const CAUSE = 'cause'
const STEPS = 'steps'
// A reaction's key: its prompt's key and its number.
const REACTION_KEY = /^(?<prompt>.+)#(?<number>\d+)$/u

type TIds = Readonly<Record<string, string>>

// The task that writes each field, by record type and field name.
const TASK_OF_FIELD = new Map(
  LABEL_TASKS.flatMap((task) => task.fields.map((field) => [`${field.recordType}/${field.name}`, task.name] as const))
)

const idOf = (ids: TIds, key: string): string => {
  const id = ids[key]
  if (id === undefined) {
    throw new Error(`The plan key ${key} has no record id`)
  }
  return id
}

// The record id the writers gave the label's key; a reaction is `<message id>#<n>`.
const recordIdOf = (ids: TIds, label: IPlannedLabel): string => {
  if (label.recordType !== 'reaction') {
    return idOf(ids, label.recordKey)
  }
  const parts = REACTION_KEY.exec(label.recordKey)?.groups
  if (parts?.prompt === undefined || parts.number === undefined) {
    throw new Error(`The reaction key ${label.recordKey} names no prompt and number`)
  }
  return `${idOf(ids, parts.prompt)}#${parts.number}`
}

// A reaction's steps name the previous turn's calls by their keys; the warehouse holds their tool call ids.
const valueOf = (ids: TIds, label: IPlannedLabel): string =>
  label.recordType === 'reaction' && label.name === STEPS
    ? label.value
        .split(',')
        .map((key) => idOf(ids, key))
        .join(',')
    : label.value

// The label row a planned label becomes.
export const recordOf = (ids: TIds, label: IPlannedLabel): ILabelRecord => ({
  recordType: label.recordType,
  recordId: recordIdOf(ids, label),
  labeller: label.labeller,
  version: label.version,
  name: label.name,
  value: valueOf(ids, label),
  labelledAt: label.labelledAt,
})

const taskOf = (label: IPlannedLabel): LabelTaskName => {
  const task = TASK_OF_FIELD.get(`${label.recordType}/${label.name}`)
  if (task === undefined) {
    throw new Error(`No engine task writes the ${label.recordType} field ${label.name}`)
  }
  return task
}

// A model cause belongs only to a failed call the rules left open.
const refuseRuleCauses = (store: WarehouseStore, demo: Pick<IDemoPlan, 'labels' | 'ids'>): void => {
  const ruled = new Set(
    store
      .all<{ record_id: string }>(
        "SELECT record_id FROM label WHERE record_type = 'tool_call' AND labeller = ? AND name = ?",
        RULES_LABELLER,
        CAUSE
      )
      .map((row) => row.record_id)
  )
  const clash = demo.labels.labels.find(
    (label) => label.recordType === 'tool_call' && label.name === CAUSE && ruled.has(recordIdOf(demo.ids, label))
  )
  if (clash !== undefined) {
    throw new LogBookError(
      `The plan gives ${clash.recordKey} a model ${CAUSE}, which the rules already gave it.`,
      DEMO_ERROR_CODES.DEMO_PLAN_INVALID
    )
  }
}

// Writes the plan's model labels and the labelling runs that wrote them into the warehouse the sync made, each run as a
// labelling run writes itself: its start with every task at `done` 0, one transaction per task with that task's labels
// and its `done` raised to its `planned`, then its end. Every time is the plan's. A plan without labels writes nothing.
export const writeLabels = async (warehousePath: string, demo: Pick<IDemoPlan, 'labels' | 'ids'>): Promise<void> => {
  const store = await WarehouseStore.open(warehousePath)
  try {
    refuseRuleCauses(store, demo)
    const byRunTask = Map.groupBy(demo.labels.labels, (label) => `${String(label.run)}/${taskOf(label)}`)
    const runTasks = new Set(
      demo.labels.runs.flatMap((run) => run.tasks.map((task) => `${String(run.number)}/${task.task}`))
    )
    const stray = [...byRunTask.keys()].find((key) => !runTasks.has(key))
    if (stray !== undefined) {
      throw new Error(`The plan has labels for ${stray}, a run task it does not plan`)
    }
    for (const run of demo.labels.runs) {
      const runId = store.startLabelRun({
        pid: run.pid,
        startedAt: run.startedAt,
        model: run.model,
        tasks: run.tasks.map(({ task, version, planned }) => ({ task, version, planned })),
      })
      for (const task of run.tasks) {
        const labels = byRunTask.get(`${String(run.number)}/${task.task}`) ?? []
        store.writeLabelRunBatch(
          runId,
          task.task,
          labels.map((label) => recordOf(demo.ids, label)),
          task.planned
        )
      }
      store.endLabelRun(runId, { endedAt: run.endedAt, outcome: run.outcome, error: run.error })
    }
  } finally {
    store.close()
  }
}
