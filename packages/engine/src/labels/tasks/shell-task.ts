import { PromptLoaderService } from '@log-book/core'
import { promptFile } from '../../prompts.js'
import type { ILabelRunTask } from '../runner/label-task.js'
import { codeFields, cutToPart, itemPart, taskInfo } from './item-text.js'

const COMMAND_SQL = "COALESCE(json_extract(tc.input_json, '$.command'), json_extract(tc.input_json, '$.cmd'))"

// Every shell call with a command, ruled or not: a model answer on a ruled call measures the rules. The model reads
// each for its purpose and, for a failed one, how it failed. Its prompt file holds no code list: the code table comes
// from the vocabulary.
export const shellTask = (): ILabelRunTask => {
  const info = taskInfo('shell')
  const command = itemPart('shell', 'command')
  const outputTail = itemPart('shell', 'output tail of a failed call')
  return {
    name: info.name,
    recordType: 'tool_call',
    version: info.version,
    fields: codeFields(info),
    batchSize: info.batchSize,
    system: 'You label shell commands for a telemetry analysis. Answer only with the requested lines.',
    instructions: PromptLoaderService.load(promptFile('shell-label.prompt.txt')),
    candidates: (reader) =>
      reader
        .all<{ id: string; command: string; isFailed: number; output: string | null }>(
          `SELECT tc.id, ${COMMAND_SQL} AS command, tc.status = 'error' AS isFailed,
             (SELECT p.text FROM part p WHERE p.tool_call_id = tc.id AND p.kind = 'tool_result') AS output
           FROM tool_call tc WHERE tc.family = 'shell' AND ${COMMAND_SQL} IS NOT NULL ORDER BY tc.id`
        )
        .map((call) => ({
          recordId: call.id,
          text: [
            call.isFailed === 1 ? '(FAILED)' : '(ok)',
            cutToPart(call.command, command),
            ...(call.isFailed === 1 ? [`--- output tail ---\n${cutToPart(call.output ?? '', outputTail)}`] : []),
          ].join('\n'),
        })),
  }
}
