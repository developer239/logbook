import { RULES_LABELLER, type ILabelRecord, type ILinkRecord, type WarehouseStore } from '@log-book/warehouse'

// Rule labels are rebuilt on every sync at no cost, so their version is a constant here, not a task version.
const SESSION_RULES_VERSION = 1

// The words of a call's text that can be a session's source id.
const ID_WORD = /[\w-]+/gu

// Which subagent started which, rebuilt from what the adapters stored: a subagent call that reports its child, and a
// session that records its parent.
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

// Which session a dispatch call started, from any harness: one whose source id is a whole word of the call's input or
// result. Neither side records the other's id, so one session named is a reconstructed link and each of several an
// ambiguous one. The call's own session and a subagent are never a dispatch's child.
const dispatchLinks = (store: WarehouseStore, subagents: ReadonlySet<string>): ILinkRecord[] => {
  const bySourceId = Map.groupBy(
    store.all<{ id: string; source_id: string }>('SELECT id, source_id FROM session ORDER BY id'),
    (row) => row.source_id
  )
  const calls = store.all<{ id: string; session_id: string; text: string }>(
    `SELECT tc.id, tc.session_id, tc.input_json || char(10) || COALESCE((SELECT group_concat(p.text, char(10)) FROM part p
       WHERE p.tool_call_id = tc.id AND p.kind = 'tool_result'), '') AS text
     FROM tool_call tc WHERE tc.family = 'dispatch' ORDER BY tc.id`
  )
  return calls.flatMap((call) => {
    const children = [...new Set(call.text.match(ID_WORD))]
      .flatMap((word) => bySourceId.get(word) ?? [])
      .map((session) => session.id)
      .filter((id) => id !== call.session_id && !subagents.has(id))
    return children.map((childSessionId): ILinkRecord => ({
      parentSessionId: call.session_id,
      parentToolCallId: call.id,
      childSessionId,
      kind: 'dispatch',
      confidence: children.length === 1 ? 'reconstructed' : 'ambiguous',
      evidence: "the dispatch call's input or result names the child session",
    }))
  })
}

// The link pass, first of a sync's derivations. A link whose parent or child the warehouse does not hold (a source
// since deleted) cannot be shown or followed, so it is left out. The store replaces every link and, in the same
// transaction, sets each session's origin from is_scripted and the links.
export const deriveLinks = (store: WarehouseStore): void => {
  const sessions = new Set(store.all<{ id: string }>('SELECT id FROM session').map((row) => row.id))
  const subagents = subagentLinks(store)
  const links = [...subagents, ...dispatchLinks(store, new Set(subagents.map((link) => link.childSessionId)))]
  store.replaceLinks(links.filter((link) => sessions.has(link.parentSessionId) && sessions.has(link.childSessionId)))
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
