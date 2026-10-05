import {
  createEngine,
  type IEngine,
  type ILabelFacts,
  type ILabelRunReport,
  type ILabelRunTaskCounts,
  type LabelRunResult,
  type LabelTaskName,
} from '@log-book/engine'
import { resolveWarehousePath } from '@log-book/warehouse'
import { exitCodeOf, type IErrorReport } from './errors.js'
import { formatCount, formatDuration } from './format.js'
import { ADAPTERS } from './grammar.js'
import { isSubscription, missingReport, missingText, providerName, signInText, taskNoun } from './labelling-lines.js'
import { integerOf, taskOf, textOf, type OptionValues } from './option-values.js'
import type { CommandRunner, ICliIo } from './run-cli.js'

// The engine's labelling operations over the warehouse at that path.
export type LabelOperations = (warehousePath: string) => IEngine['labels']

type TCallOptions = Parameters<IEngine['labels']['update']>[0]
type TProgress = NonNullable<TCallOptions['onProgress']>
type TProgressEvent = Parameters<TProgress>[0]

// A task's word padded so its counts line up: `shell calls    1,200 of 2,140`.
const TASK_COLUMN = 14
const ESTIMATE_DIGITS = 2
const CURSOR_UP = (lines: number): string => `\u001B[${String(lines)}A`
const CLEAR_LINE = '\u001B[2K'
const NOTHING_TO_LABEL = 'Nothing to label: every record already has a label from a model.'
const TO_LABEL_NOTHING = 'To label: nothing. Every record already has a label from a model.'

const line = (text: string): string => `${text}\n`

const records = (count: number): string => `${formatCount(count)} ${count === 1 ? 'record' : 'records'}`

// The estimate to two significant figures, so it reads as one: about 560,000.
const roughly = (tokens: number): string => formatCount(tokens === 0 ? 0 : Number(tokens.toPrecision(ESTIMATE_DIGITS)))

const toLabelLine = (facts: ILabelFacts): string => {
  if (facts.records === 0) {
    return TO_LABEL_NOTHING
  }
  const tasks = facts.tasks
    .filter((task) => task.records > 0)
    .map((task) => `${taskNoun(task.task, task.records)} ${formatCount(task.records)}`)
  const agents = facts.harnesses
    .filter((harness) => harness.records > 0)
    .map((harness) => `${harness.name ?? harness.id} ${formatCount(harness.records)}`)
  return `To label: ${records(facts.records)} (${tasks.join(', ')}); by agent: ${agents.join(', ')}.`
}

// What the run is about to send, before the first batch; the run goes on without asking.
const preflightLines = (facts: ILabelFacts): string[] => {
  const sign = { authMethod: facts.authMethod, apiProvider: facts.apiProvider }
  const plan = isSubscription(sign) ? "Requests count against your Claude plan's usage limits. " : ''
  return [
    `Labelling with your own claude ${facts.claudeVersion}, ${signInText(sign, false)}, on ${facts.model}.`,
    ...(facts.apiKeyInEnvironment
      ? ['ANTHROPIC_API_KEY is set, so Claude Code may bill this run to that key instead of your plan.']
      : []),
    toLabelLine(facts),
    `${plan}Excerpts of these records go to ${providerName(facts.apiProvider)} through Claude Code; nothing is redacted.`,
    ...(facts.records === 0
      ? []
      : [
          `Estimated: about ${roughly(facts.estimatedInputTokens)} input tokens. Press Ctrl+C to stop; what is ` +
            'labelled is kept.',
        ]),
  ]
}

const progressLine = (task: LabelTaskName, done: number, planned: number): string =>
  `${taskNoun(task, planned).padEnd(TASK_COLUMN)} ${formatCount(done)} of ${formatCount(planned)}`

interface IProgressWriter {
  onProgress: TProgress
  finish: (tasks: readonly ILabelRunTaskCounts[]) => void
}

// On a terminal the task lines are redrawn as batches land; elsewhere each is printed once, as its task ends. A task
// with nothing to label has no line.
const progressWriter = (io: ICliIo): IProgressWriter => {
  const lines = new Map<LabelTaskName, string>()
  const printed = new Set<LabelTaskName>()
  let drawn = 0
  const redraw = (): void => {
    const up = drawn === 0 ? '' : CURSOR_UP(drawn)
    io.stderr(up + [...lines.values()].map((text) => `${CLEAR_LINE}${text}\n`).join(''))
    drawn = lines.size
  }
  const print = (task: LabelTaskName): void => {
    const text = lines.get(task)
    if (text !== undefined && !printed.has(task)) {
      printed.add(task)
      io.stderr(line(text))
    }
  }
  return {
    onProgress: (event: TProgressEvent) => {
      lines.set(event.task, progressLine(event.task, event.labelled, event.planned))
      if (io.isStderrTty) {
        redraw()
      } else if (event.stop !== null || event.labelled + event.unanswered >= event.planned) {
        print(event.task)
      }
    },
    finish: (tasks) => {
      for (const task of tasks.filter(({ planned }) => planned > 0)) {
        lines.set(task.task, progressLine(task.task, task.done, task.planned))
      }
      if (io.isStderrTty) {
        redraw()
        return
      }
      for (const task of lines.keys()) {
        print(task)
      }
    },
  }
}

const kept = (report: ILabelRunReport): string =>
  `${formatCount(report.totals.done)} of ${records(report.totals.planned)} labelled and kept.`

const okSummary = (report: ILabelRunReport): string => {
  if (report.totals.planned === 0) {
    return NOTHING_TO_LABEL
  }
  const labelled = `Labelled ${records(report.totals.done)} in ${formatDuration(report.durationMs)}.`
  const { unanswered } = report.totals
  if (unanswered === 0) {
    return labelled
  }
  return `${labelled}\n${records(unanswered)} got no answer; the next run asks for them again.`
}

const errorOf = (report: ILabelRunReport): string => {
  if (report.error === null) {
    throw new Error(`A labelling run that ended ${report.outcome} came back without its error`)
  }
  return report.error
}

type TFailureKind = NonNullable<ILabelRunReport['failureKind']>

// A failed run's summary by why it failed: a missing prerequisite exits 7 as detection would have.
const FAILED_SUMMARIES: Readonly<Record<TFailureKind, (report: ILabelRunReport) => IErrorReport>> = {
  'not-signed-in': (report) => ({
    code: exitCodeOf('missing prerequisite'),
    line: `${errorOf(report)} Run claude, sign in, then run this again. ${kept(report)}`,
  }),
  'not-found': (report) => ({
    code: exitCodeOf('missing prerequisite'),
    line: `${missingText({ kind: 'not-found', variable: null })}. ${kept(report)}`,
  }),
  'failure': (report) => ({
    code: exitCodeOf('failure'),
    line: `${errorOf(report)} ${kept(report)} Run the same command again once fixed, for example with another --model.`,
  }),
}

const SUMMARIES: Readonly<Record<ILabelRunReport['outcome'], (report: ILabelRunReport) => IErrorReport>> = {
  ok: (report) => ({ code: exitCodeOf('success'), line: okSummary(report) }),
  stopped: (report) => ({
    code: exitCodeOf('interrupted'),
    line: `Labelling stopped: ${kept(report)} Run the same command again to continue.`,
  }),
  limit: (report) => ({
    code: exitCodeOf('usage limit'),
    line: `${errorOf(report)} ${kept(report)} Run the same command again once the limit resets.`,
  }),
  unreachable: (report) => ({
    code: exitCodeOf('failure'),
    line: `${errorOf(report)} ${kept(report)} Run the same command again when you are online.`,
  }),
  failed: (report) => {
    if (report.failureKind === null) {
      throw new Error('A failed labelling run came back without its failure kind')
    }
    return FAILED_SUMMARIES[report.failureKind](report)
  },
}

// The summary a run ends with on stdout, and its exit code.
const labelSummary = (report: ILabelRunReport): IErrorReport => SUMMARIES[report.outcome](report)

type TStart = (labels: IEngine['labels'], call: TCallOptions, values: OptionValues) => Promise<LabelRunResult>

export const engineLabels: LabelOperations = (warehousePath) =>
  createEngine({ adapters: ADAPTERS, warehousePath }).labels

// A labelling command: detection, the labelling lock, the preflight and progress on stderr, then one summary on
// stdout. A held lock is thrown by the engine and ends the command through its error line.
const labellingRunner =
  (labelsOf: LabelOperations, start: TStart): CommandRunner =>
  async ({ values, io }) => {
    const progress = progressWriter(io)
    const model = textOf(values, 'model')
    const call: TCallOptions = {
      signal: io.signal,
      onPreflight: (facts) => {
        for (const text of preflightLines(facts)) {
          io.stderr(line(text))
        }
      },
      onProgress: progress.onProgress,
      ...(model === undefined ? {} : { model }),
    }
    const result = await start(labelsOf(resolveWarehousePath()), call, values)
    if (result.status === 'missing') {
      const missing = missingReport(result.missing)
      io.stderr(line(missing.line))
      return missing.code
    }
    progress.finish(result.tasks)
    const summary = labelSummary(result)
    io.stdout(line(summary.line))
    return summary.code
  }

// `logbook labels update` and `logbook labels run`.
export const createLabelRunners = (
  labelsOf: LabelOperations = engineLabels
): Readonly<Record<string, CommandRunner>> => ({
  'labels update': labellingRunner(labelsOf, async (labels, call) => labels.update(call)),
  'labels run': labellingRunner(labelsOf, async (labels, call, values) => {
    const sample = integerOf(values, 'sample')
    const limit = integerOf(values, 'limit')
    return labels.run({
      ...call,
      task: taskOf(values),
      ...(sample === undefined ? {} : { sample }),
      ...(limit === undefined ? {} : { limit }),
    })
  }),
})
