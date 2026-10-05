import { PromptLoaderService } from '@log-book/core'
import { RULES_LABELLER } from '@log-book/warehouse'
import type { ILabelRunTask } from '../runner/label-task.js'
import { codeFields, cutToPart, itemPart, taskInfo } from './item-text.js'

// Failed calls outside the shell with an error text and no cause from the rules: the few the rules leave open.
export const toolFailureTask = (): ILabelRunTask => {
  const info = taskInfo('tool-failure')
  const input = itemPart('tool-failure', 'input')
  const error = itemPart('tool-failure', 'error')
  return {
    name: info.name,
    recordType: 'tool_call',
    version: info.version,
    fields: codeFields(info),
    batchSize: info.batchSize,
    system: 'You label failed tool calls for a telemetry analysis. Answer only with the requested lines.',
    instructions: PromptLoaderService.load(new URL('../../prompts/tool-failure.prompt.txt', import.meta.url)),
    candidates: (reader) =>
      reader
        .all<{ id: string; name: string; input: string; error: string }>(
          `SELECT tc.id, tc.name, tc.input_json AS input, p.text AS error
           FROM tool_call tc JOIN part p ON p.tool_call_id = tc.id AND p.kind = 'tool_result'
           WHERE tc.status = 'error' AND tc.family <> 'shell' AND length(trim(p.text)) > 0
             AND NOT EXISTS (SELECT 1 FROM label l WHERE l.record_type = 'tool_call' AND l.record_id = tc.id
               AND l.labeller = ? AND l.name = 'cause')
           ORDER BY tc.id`,
          RULES_LABELLER
        )
        .map((call) => ({
          recordId: call.id,
          text: [
            `tool ${call.name}`,
            `input ${cutToPart(call.input, input)}`,
            `--- error ---\n${cutToPart(call.error, error)}`,
          ].join('\n'),
        })),
  }
}
