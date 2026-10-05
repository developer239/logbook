import { RULES_LABELLER, type ILabelRecord, type WarehouseStore } from '@log-book/warehouse'
import { shellRuleLabels, type IShellCall } from '../labels/rules/shell-rules.js'
import { toolFailureRuleLabels, type IFailedCall } from '../labels/rules/tool-failure-rules.js'

const TOOL_RECOVERY_RULES_VERSION = 1
// The part of a failed call's result the cause rules read. SQLite's substr counts characters, so a cut never splits
// one.
const ERROR_CHARS = 600

// A label of a tool call: the rules' when they gave one, else a model's newest.
const purposeOf = (call: string): string =>
  `COALESCE(
     (SELECT l.value FROM label l WHERE l.record_type = 'tool_call' AND l.record_id = ${call}.id
        AND l.labeller = '${RULES_LABELLER}' AND l.name = 'purpose' ORDER BY l.labelled_at DESC LIMIT 1),
     (SELECT l.value FROM label l WHERE l.record_type = 'tool_call' AND l.record_id = ${call}.id
        AND l.labeller <> '${RULES_LABELLER}' AND l.name = 'purpose' ORDER BY l.labelled_at DESC LIMIT 1))`

// Whether the agent got past each failed call of any tool, shell included, before the human's next prompt: a later
// call of the same tool in the same session completed, with the same purpose for a shell call (a failing test run
// followed by a passing one, not by any command at all). Calls in one message can run side by side, so their order is
// their start time.
const RECOVERY_READ = `SELECT f.id, EXISTS (
    SELECT 1 FROM tool_call n JOIN message nm ON nm.id = n.message_id
    WHERE n.session_id = f.session_id AND n.name = f.name AND n.status = 'completed' AND n.id <> f.id
      AND (nm.seq > fm.seq OR (nm.seq = fm.seq AND COALESCE(n.started_at, 0) > COALESCE(f.started_at, 0)))
      AND nm.seq < COALESCE((SELECT MIN(u.seq) FROM message u
        WHERE u.session_id = f.session_id AND u.actor = 'user' AND u.seq > fm.seq), ${String(Number.MAX_SAFE_INTEGER)})
      AND (f.family <> 'shell' OR ${purposeOf('n')} IS ${purposeOf('f')})
  ) AS is_recovered
  FROM tool_call f JOIN message fm ON fm.id = f.message_id WHERE f.status = 'error' ORDER BY f.id`

const recoveryLabels = (store: WarehouseStore, labelledAt: number): ILabelRecord[] =>
  store.all<{ id: string; is_recovered: number }>(RECOVERY_READ).map((call) => ({
    recordType: 'tool_call',
    recordId: call.id,
    labeller: RULES_LABELLER,
    version: TOOL_RECOVERY_RULES_VERSION,
    name: 'recovery',
    value: call.is_recovered === 1 ? 'recovered' : 'not recovered',
    labelledAt,
  }))

// The tool call rules of a sync. The shell purposes and the failure causes replace every rules label on tool_call in
// one transaction, so a reader never sees one without the other. Recovery is written after it, because that write
// removed the previous recovery labels and recovery reads the shell purposes. labelledAt is the caller's.
export const deriveToolCallRules = (store: WarehouseStore, labelledAt: number): void => {
  const shellCalls = store.all<IShellCall>(
    "SELECT id, family, input_json AS inputJson FROM tool_call WHERE family = 'shell' ORDER BY id"
  )
  // A failed call outside the shell with a result to read; a shell call's cause is its own failure field.
  const failedCalls = store
    .all<{ id: string; error: string | null }>(
      `SELECT tc.id, (SELECT substr(p.text, 1, ${String(ERROR_CHARS)}) FROM part p
         WHERE p.tool_call_id = tc.id AND p.kind = 'tool_result') AS error
       FROM tool_call tc WHERE tc.status = 'error' AND tc.family <> 'shell' ORDER BY tc.id`
    )
    .flatMap(({ id, error }): IFailedCall[] => (error === null || error.trim() === '' ? [] : [{ id, error }]))
  store.replaceRuleLabels('tool_call', [
    ...shellRuleLabels(shellCalls, labelledAt),
    ...toolFailureRuleLabels(failedCalls, labelledAt),
  ])
  store.writeLabels(recoveryLabels(store, labelledAt))
}
