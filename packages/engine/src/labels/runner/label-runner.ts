import { createHash } from 'node:crypto'
import { RULES_LABELLER, type ILabelRecord, type WarehouseStore } from '@log-book/warehouse'
import { runLabelBatch } from '../../claude/batch-call.js'
import type { BatchResult } from '../../claude/batch-result.js'
import { parseBatchAnswer, type IItemAnswer, type TLabelValues } from './batch-answer.js'
import { renderBatchPrompt } from './batch-prompt.js'
import type { ILabelItem, ILabelRunTask } from './label-task.js'

const DEFAULT_CONCURRENCY = 4
// A batch discarded twice is asked in batches of this size, each once.
const RETRY_BATCH_SIZE = 5
const WHOLE_ATTEMPTS = 2
// A text answered so means none and writes no row.
const NO_TEXT = '-'
const MS_PER_MINUTE = 60_000

// What ended a task early: a stop from the client, which lets the batches in flight finish, or the run's own abort.
interface ILabelTaskStop {
  outcome: 'limit' | 'unreachable' | 'failed' | 'stopped'
  isMissingPrerequisite: boolean
  detail: string | null
}

export interface ILabelTaskResult {
  task: string
  // The pending records the task set out to label.
  planned: number
  labelled: number
  // Records in batches that ran and got no labels, for the next run.
  unanswered: number
  inputTokens: number
  outputTokens: number
  minutes: number
  stop: ILabelTaskStop | null
}

export interface ILabelTaskRun {
  store: WarehouseStore
  runId: number
  task: ILabelRunTask
  // The labeller of every label the run writes.
  model: string
  // Whose labels make a record done: any model's (`labels update`), or the run's own model's only (`labels run`, so a
  // comparison sample can be labelled by a second model). A `rules` label never does.
  doneBy: 'any-model' | 'own-model'
  claude: { binary: string; cwd: string; timeoutMs?: number }
  // A fixed sample of this many records, the same for every model.
  sample?: number
  // At most this many of the pending records.
  limit?: number
  concurrency?: number
  signal: AbortSignal
  onProgress?: (result: ILabelTaskResult) => void
}

// Deterministic order for a sample: by the SHA-256 of the record id.
const sampleKey = (recordId: string): string => createHash('sha256').update(recordId).digest('hex')

const firstField = (task: ILabelRunTask): string => {
  const [field] = task.fields
  if (field === undefined) {
    throw new Error(`The label task ${task.name} has no fields.`)
  }
  return field.name
}

// The records labelled with the task's first field at its current version, built again from the warehouse each run.
const labelledIds = (run: ILabelTaskRun): Set<string> => {
  const byLabeller = run.doneBy === 'own-model' ? 'labeller = ?' : 'labeller <> ?'
  const rows = run.store.all<{ id: string }>(
    `SELECT DISTINCT record_id AS id FROM label WHERE record_type = ? AND name = ? AND version = ? AND ${byLabeller}`,
    run.task.recordType,
    firstField(run.task),
    run.task.version,
    run.doneBy === 'own-model' ? run.model : RULES_LABELLER
  )
  return new Set(rows.map((row) => row.id))
}

const pendingOf = (run: ILabelTaskRun): ILabelItem[] => {
  const candidates = run.task.candidates(run.store)
  const chosen =
    run.sample === undefined
      ? candidates
      : candidates
          .map((item) => ({ item, key: sampleKey(item.recordId) }))
          .toSorted((left, right) => (left.key < right.key ? -1 : 1))
          .slice(0, run.sample)
          .map(({ item }) => item)
  const done = labelledIds(run)
  return chosen.filter((item) => !done.has(item.recordId)).slice(0, run.limit)
}

const chunk = <TItem>(items: readonly TItem[], size: number): TItem[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_chunk, index) =>
    items.slice(index * size, (index + 1) * size)
  )

// The label rows of one answer: the item's fields, and each entry as record `<item>#<n>` in answer order.
const labelRows = (run: ILabelTaskRun, answer: IItemAnswer, labelledAt: number): ILabelRecord[] => {
  const rows = (recordType: ILabelRecord['recordType'], recordId: string, values: TLabelValues): ILabelRecord[] =>
    values
      .filter(({ value }) => value !== NO_TEXT)
      .map(({ name, value }) => ({
        recordType,
        recordId,
        labeller: run.model,
        version: run.task.version,
        name,
        value,
        labelledAt,
      }))
  const { entries } = run.task
  return [
    ...rows(run.task.recordType, answer.item.recordId, answer.fields),
    ...(entries === undefined
      ? []
      : answer.entries.flatMap((entry, index) =>
          rows(entries.recordType, `${answer.item.recordId}#${String(index + 1)}`, entry)
        )),
  ]
}

// One request's outcome: the answers when kept, null when discarded, or what halts the batch.
type TAttempt =
  | { kind: 'kept'; answers: IItemAnswer[] }
  | { kind: 'discarded' }
  | { kind: 'halted'; result: Exclude<BatchResult, { type: 'answer' } | { type: 'too-long' }> }

class TaskRunner {
  private readonly run: ILabelTaskRun
  private readonly result: ILabelTaskResult
  private readonly queue: ILabelItem[][]
  private readonly startedAt = Date.now()

  constructor(run: ILabelTaskRun, pending: readonly ILabelItem[]) {
    this.run = run
    this.queue = chunk(pending, run.task.batchSize)
    this.result = {
      task: run.task.name,
      planned: pending.length,
      labelled: 0,
      unanswered: 0,
      inputTokens: 0,
      outputTokens: 0,
      minutes: 0,
      stop: null,
    }
  }

  public readonly label = async (): Promise<ILabelTaskResult> => {
    const workers = Math.max(1, this.run.concurrency ?? DEFAULT_CONCURRENCY)
    await Promise.all(Array.from({ length: workers }, async () => this.work()))
    this.result.minutes = Math.round(((Date.now() - this.startedAt) / MS_PER_MINUTE) * 10) / 10
    return { ...this.result }
  }

  // Takes batches until none is left, a stop came or the run was aborted: no new batch starts after either.
  private readonly work = async (): Promise<void> => {
    const batch = this.result.stop === null && !this.run.signal.aborted ? this.queue.shift() : undefined
    if (batch === undefined) {
      return
    }
    await this.answerBatch(batch)
    await this.work()
  }

  // The batch whole, twice, then in batches of 5, each once. A timeout leaves the batch unanswered and the task goes
  // on; a stop or an abort ends it.
  private readonly answerBatch = async (batch: ILabelItem[]): Promise<void> => {
    const whole = await this.attemptWhole(batch, WHOLE_ATTEMPTS)
    if (whole.kind === 'kept') {
      this.keep(whole.answers)
      return
    }
    if (whole.kind === 'halted' || batch.length <= RETRY_BATCH_SIZE) {
      this.leave(batch, whole)
      return
    }
    await chunk(batch, RETRY_BATCH_SIZE).reduce(async (previous, part) => {
      await previous
      if (this.result.stop !== null || this.run.signal.aborted) {
        this.leave(part, { kind: 'discarded' })
        return
      }
      const attempt = await this.attempt(part)
      if (attempt.kind === 'kept') {
        this.keep(attempt.answers)
      } else {
        this.leave(part, attempt)
      }
    }, Promise.resolve())
  }

  private readonly attemptWhole = async (batch: ILabelItem[], attemptsLeft: number): Promise<TAttempt> => {
    const attempt = await this.attempt(batch)
    return attempt.kind === 'discarded' && attemptsLeft > 1 ? this.attemptWhole(batch, attemptsLeft - 1) : attempt
  }

  private readonly attempt = async (batch: ILabelItem[]): Promise<TAttempt> => {
    const { task, model, claude, signal } = this.run
    const result = await runLabelBatch({
      binary: claude.binary,
      model,
      systemPrompt: task.system,
      prompt: renderBatchPrompt(task, batch),
      cwd: claude.cwd,
      signal,
      ...(claude.timeoutMs === undefined ? {} : { timeoutMs: claude.timeoutMs }),
    })
    if (result.type === 'too-long') {
      return { kind: 'discarded' }
    }
    if (result.type !== 'answer') {
      return { kind: 'halted', result }
    }
    this.result.inputTokens += result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens
    this.result.outputTokens += result.usage.outputTokens
    const answers = parseBatchAnswer(task, batch, result.text)
    return answers === null ? { kind: 'discarded' } : { kind: 'kept', answers }
  }

  // A kept batch's labels and the increase of the task's `done`, in one transaction, as the batch lands.
  private readonly keep = (answers: IItemAnswer[]): void => {
    const labelledAt = Date.now()
    const labels = answers.flatMap((answer) => labelRows(this.run, answer, labelledAt))
    this.run.store.writeLabelRunBatch(this.run.runId, this.run.task.name, labels, answers.length)
    this.result.labelled += answers.length
    this.run.onProgress?.({ ...this.result })
  }

  private readonly leave = (batch: readonly ILabelItem[], attempt: TAttempt): void => {
    this.result.unanswered += batch.length
    if (attempt.kind === 'halted') {
      this.halt(attempt.result)
    }
    this.run.onProgress?.({ ...this.result })
  }

  private readonly halt = (result: Exclude<BatchResult, { type: 'answer' } | { type: 'too-long' }>): void => {
    if (result.type === 'timeout' || this.result.stop !== null) {
      return
    }
    this.result.stop =
      result.type === 'aborted'
        ? { outcome: 'stopped', isMissingPrerequisite: false, detail: null }
        : { outcome: result.outcome, isMissingPrerequisite: result.isMissingPrerequisite, detail: result.detail }
  }
}

// Labels a task's pending records in tagged batches through the Claude client, keeps a batch only when every item got
// a valid answer, and writes each kept batch as it lands. A run stopped at any point keeps every batch it wrote, and
// the next run asks only for what is still unlabelled. Up to 4 batches are in flight, each its own `claude -p`.
export const runLabelTask = async (run: ILabelTaskRun): Promise<ILabelTaskResult> => {
  const pending = pendingOf(run)
  run.store.replanLabelRunTask(run.runId, run.task.name, pending.length)
  return new TaskRunner(run, pending).label()
}
