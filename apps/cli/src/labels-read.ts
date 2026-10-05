import type { ILabelPreview } from '@log-book/engine'
import { resolveWarehousePath } from '@log-book/warehouse'
import { exitCodeOf } from './errors.js'
import { formatCount } from './format.js'
import { missingReport } from './labelling-lines.js'
import { engineLabels, type LabelOperations } from './labels-run.js'
import { integerOf, requiredTextOf, taskOf, textOf } from './option-values.js'
import type { CommandRunner } from './run-cli.js'

const line = (text: string): string => `${text}\n`

const plural = (count: number, one: string, many: string): string => `${formatCount(count)} ${count === 1 ? one : many}`

// The batches a preview shows, as a person reads them; not a format to parse.
const previewText = (preview: ILabelPreview): string => {
  const head = `Preview of task ${preview.task}`
  if (preview.batches.length === 0) {
    return `${head}: nothing to label; every record already has a label from a model.`
  }
  const records = preview.batches.reduce((sum, batch) => sum + batch.records, 0)
  const total = preview.batches.length
  const sent = total === 1 ? 'it' : 'them'
  return [
    `${head}: the next ${plural(total, 'batch', 'batches')}, ${plural(records, 'record', 'records')}, exactly as ` +
      `labelling would send ${sent} now. Nothing is sent.`,
    '',
    'System line (passed to claude as --system-prompt):',
    preview.system,
    ...preview.batches.flatMap((batch, index) => [
      '',
      `Batch ${String(index + 1)} of ${String(total)} (sent on the stdin of one claude -p call, ` +
        `${plural(batch.records, 'record', 'records')}):`,
      batch.prompt,
    ]),
    '',
    preview.note,
  ].join('\n')
}

// `logbook labels plan`, `labels preview` and `labels compare`: they only read, so none takes a lock, writes a run
// record or starts a `claude -p` call.
export const createLabelReadRunners = (
  labelsOf: LabelOperations = engineLabels
): Readonly<Record<string, CommandRunner>> => ({
  // The CLI's one JSON output: the web app reads the facts and cannot import the engine.
  'labels plan': async ({ values, io }) => {
    const model = textOf(values, 'model')
    const plan = await labelsOf(resolveWarehousePath()).plan({
      signal: io.signal,
      ...(model === undefined ? {} : { model }),
    })
    if (plan.status === 'missing') {
      const missing = missingReport(plan.missing)
      io.stderr(line(missing.line))
      return missing.code
    }
    io.stdout(line(JSON.stringify(plan.facts)))
    return exitCodeOf('success')
  },
  'labels preview': async ({ values, io }) => {
    const batches = integerOf(values, 'batches')
    const preview = await labelsOf(resolveWarehousePath()).preview({
      task: taskOf(values),
      ...(batches === undefined ? {} : { batches }),
    })
    io.stdout(line(previewText(preview)))
    return exitCodeOf('success')
  },
  'labels compare': async ({ values, io }) => {
    const comparison = await labelsOf(resolveWarehousePath()).compare({
      task: taskOf(values),
      first: requiredTextOf(values, 'first'),
      second: requiredTextOf(values, 'second'),
    })
    io.stdout(line(comparison))
    return exitCodeOf('success')
  },
})
