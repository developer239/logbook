import { RULES_LABELLER, type ILabelRecord, type ILinkRecord, type WarehouseStore } from '@log-book/warehouse'

// Rule labels are rebuilt on every sync at no cost, so their version is a constant here, not a task version.
const SESSION_RULES_VERSION = 1

// Which session started which, rebuilt from what the adapters stored: a subagent call that reports its child, and a
// session that records its parent. Only subagent links exist: a call of the dispatch family gets none, and the session
// it started lists as a conversation of its own.
const subagentLinks = (store: WarehouseStore): ILinkRecord[] => {
  const byCall = store
    .all<{ id: string; session_id: string; child_session_id: string }>(
      `SELECT tc.id, tc.session_id, tc.child_session_id FROM tool_call tc
       JOIN session s ON s.id = tc.child_session_id
       WHERE tc.child_session_id IS NOT NULL
       ORDER BY tc.id`
    )
    .map((row): ILinkRecord => ({
      parentSessionId: row.session_id,
      parentToolCallId: row.id,
      childSessionId: row.child_session_id,
      kind: 'subagent',
      confidence: 'exact',
      evidence: 'the subagent tool call reported the child session',
    }))
  const linked = new Set(byCall.map((link) => link.childSessionId))
  const bySession = store
    .all<{ id: string; spawned_by_session_id: string; spawned_by_tool_call_id: string | null }>(
      `SELECT id, spawned_by_session_id, spawned_by_tool_call_id FROM session
       WHERE spawned_by_session_id IS NOT NULL ORDER BY id`
    )
    .filter((row) => !linked.has(row.id))
    .map((row): ILinkRecord => ({
      parentSessionId: row.spawned_by_session_id,
      parentToolCallId: row.spawned_by_tool_call_id,
      childSessionId: row.id,
      kind: 'subagent',
      confidence: 'exact',
      evidence: 'the subagent session records its parent session',
    }))
  return [...byCall, ...bySession]
}

// The link pass, first of a sync's derivations. A link whose parent or child the warehouse does not hold (a source
// since deleted) cannot be shown or followed, so it is left out. The store replaces every link and, in the same
// transaction, sets each session's origin from is_scripted and the links.
export const deriveLinks = (store: WarehouseStore): void => {
  const sessions = new Set(store.all<{ id: string }>('SELECT id FROM session').map((row) => row.id))
  store.replaceLinks(
    subagentLinks(store).filter((link) => sessions.has(link.parentSessionId) && sessions.has(link.childSessionId))
  )
}

// The initiator pass, last of a sync's derivations: a person starts every interactive session, and an agent or a
// program every other one. It replaces every rules label of the session record type; labelledAt is the caller's.
export const deriveInitiators = (store: WarehouseStore, labelledAt: number): void => {
  const labels = store
    .all<{ id: string; origin: string }>('SELECT id, origin FROM session ORDER BY id')
    .map((session): ILabelRecord => ({
      recordType: 'session',
      recordId: session.id,
      labeller: RULES_LABELLER,
      version: SESSION_RULES_VERSION,
      name: 'initiator',
      value: session.origin === 'interactive' ? 'human' : 'agent',
      labelledAt,
    }))
  store.replaceRuleLabels('session', labels)
}
