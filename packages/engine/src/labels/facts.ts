import type { IWarehouseReader, LabelRecordType } from '@log-book/warehouse'
import type { ClaudeDetection } from '../claude/detect.js'
import { LABEL_INPUT_RATES } from './rates.js'
import { pendingRecords } from './runner/label-runner.js'
import type { ILabelRunTask } from './runner/label-task.js'
import type { LabelTaskName } from './tasks.js'

// What a run would send, before any record leaves the machine. The field names are a contract with the web app,
// through the CLI's JSON form.
export interface ILabelFacts {
  model: string
  claudeVersion: string
  authMethod: string | null
  apiProvider: string | null
  apiKeyInEnvironment: boolean
  tasks: { task: LabelTaskName; records: number }[]
  harnesses: { id: string; name: string | null; records: number }[]
  records: number
  estimatedInputTokens: number
}

type TReady = Extract<ClaudeDetection, { status: 'ready' }>

// The session a record of each type belongs to.
const SESSION_OF: Readonly<Record<LabelRecordType, string>> = {
  session: 'SELECT x.value AS id, x.value AS session FROM json_each(?) x',
  message: 'SELECT x.value AS id, m.session_id AS session FROM json_each(?) x JOIN message m ON m.id = x.value',
  tool_call: 'SELECT x.value AS id, t.session_id AS session FROM json_each(?) x JOIN tool_call t ON t.id = x.value',
  reaction: 'SELECT x.value AS id, NULL AS session FROM json_each(?) x',
}

// The records of each harness among a task's pending ones.
const harnessCounts = (reader: IWarehouseReader, task: ILabelRunTask, ids: readonly string[]): Map<string, number> => {
  const rows = reader.all<{ harness: string; records: number }>(
    `SELECT s.harness, COUNT(*) AS records FROM (${SESSION_OF[task.recordType]}) r JOIN session s ON s.id = r.session
     GROUP BY s.harness`,
    JSON.stringify(ids)
  )
  return new Map(rows.map((row) => [row.harness, row.records]))
}

// The facts of a run of the tasks, counted with the pending rule of `labels update`. One function builds them for the
// plan and for a run's preflight, so a run started right after a plan on an unchanged warehouse counts the same.
export const buildLabelFacts = (
  reader: IWarehouseReader,
  tasks: readonly ILabelRunTask[],
  model: string,
  claude: TReady
): ILabelFacts => {
  const byHarness = new Map<string, number>()
  const counts = tasks.map((task) => {
    const pending = pendingRecords(reader, { task, model, doneBy: 'any-model' })
    for (const [harness, records] of harnessCounts(
      reader,
      task,
      pending.map((item) => item.recordId)
    )) {
      byHarness.set(harness, (byHarness.get(harness) ?? 0) + records)
    }
    return { task: task.name, records: pending.length }
  })
  const names = new Map(
    reader.all<{ id: string; name: string }>('SELECT id, name FROM harness').map((row) => [row.id, row.name])
  )
  return {
    model,
    claudeVersion: claude.version,
    authMethod: claude.authMethod,
    apiProvider: claude.apiProvider,
    apiKeyInEnvironment: claude.hasApiKey,
    tasks: counts,
    harnesses: [...byHarness.entries()]
      .toSorted(([left], [right]) => (left < right ? -1 : 1))
      .map(([id, records]) => ({ id, name: names.get(id) ?? null, records })),
    records: counts.reduce((sum, { records }) => sum + records, 0),
    estimatedInputTokens: counts.reduce(
      (sum, { task, records }) => sum + records * LABEL_INPUT_RATES[task].tokensPerRecord,
      0
    ),
  }
}
