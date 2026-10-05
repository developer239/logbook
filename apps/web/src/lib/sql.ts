// Labels are read one record at a time by the label table's key: a join to a
// derived table of all labels takes minutes.

type RecordType = 'tool_call' | 'session'

export const modelLabel = (recordType: RecordType, recordId: string, name: string): string =>
  `(SELECT l.value FROM label l WHERE l.record_type = '${recordType}' AND l.record_id = ${recordId}
     AND l.name = '${name}' AND l.labeller <> 'rules' ORDER BY l.labelled_at DESC LIMIT 1)`

const ruleLabel = (recordType: RecordType, recordId: string, name: string): string =>
  `(SELECT l.value FROM label l WHERE l.record_type = '${recordType}' AND l.record_id = ${recordId}
     AND l.name = '${name}' AND l.labeller = 'rules' LIMIT 1)`

const anyLabel = (recordType: RecordType, recordId: string, name: string): string =>
  `COALESCE(${ruleLabel(recordType, recordId, name)}, ${modelLabel(recordType, recordId, name)})`

export const callAt = (call: string): string =>
  `COALESCE(${call}.started_at, (SELECT m.created_at FROM message m WHERE m.id = ${call}.message_id))`

export const CALL_AT = callAt('tc')

// By message order, as the conversation page reads turns: times can overlap
// where the order cannot.
export const turnOfCall = (callId: string): string =>
  `(SELECT t.message_id FROM turn t JOIN message tm ON tm.id = t.message_id
     JOIN tool_call c ON c.id = ${callId} JOIN message cm ON cm.id = c.message_id
     WHERE t.session_id = c.session_id AND tm.seq <= cm.seq ORDER BY tm.seq DESC LIMIT 1)`

// What Claude Code writes in the user's name that the user did not type. The
// cookbook reads these prompts the same way.
export const HARNESS_PREFIXES = ['<local-command', '<command-', 'Caveat:', '[Request interrupted'] as const

// GLOB reads [ as the start of a class, so it is written as a class of its own.
const globOf = (prefix: string): string => `${prefix.replaceAll('[', '[[]')}*`

const isTyped = (text: string): string =>
  `NOT (${HARNESS_PREFIXES.map((prefix) => `ltrim(${text}) GLOB '${globOf(prefix)}'`).join(' OR ')})`

export const titleOf = (sessionId: string): string =>
  `COALESCE(NULLIF((SELECT s2.title FROM session s2 WHERE s2.id = ${sessionId}), ''),
     (SELECT substr(p.text, 1, 90) FROM message m JOIN part p ON p.message_id = m.id AND p.kind = 'text'
      WHERE m.session_id = ${sessionId} AND m.actor = 'user' AND ${isTyped('p.text')} ORDER BY m.seq, p.idx LIMIT 1))`

export const byAgent = (session: string): string =>
  `(${session}.origin = 'subagent' OR EXISTS (SELECT 1 FROM turn t WHERE t.session_id = ${session}.id
     AND t.parent_turn_id IS NOT NULL))`

export const startedBy = (session: string): string =>
  `CASE WHEN ${session}.origin = 'interactive' THEN 'me' WHEN ${byAgent(session)} THEN 'agent' ELSE 'script' END`

export const retryLoop = (call: string): string => `COUNT(*) >= 3 AND SUM(${call}.status = 'error') >= 2`

// Escapes a value for a LIKE pattern with ESCAPE '\', so its %, _ and \ stand
// for themselves.
export const literal = (value: string): string =>
  `replace(replace(replace(${value}, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`

// Binds the name twice.
export const toolIs = (name: string): string =>
  `(lower(${name}) = lower(?) OR lower(${name}) LIKE 'mcp\\_\\_%\\_\\_' || ${literal('lower(?)')} ESCAPE '\\')`

export const failureLabel = (call: string): string =>
  `CASE WHEN ${call}.status <> 'error' THEN NULL
     WHEN ${call}.family = 'shell' THEN ${modelLabel('tool_call', `${call}.id`, 'failure')}
     ELSE ${anyLabel('tool_call', `${call}.id`, 'cause')} END`

export const purposeLabel = (call: string): string =>
  `CASE WHEN ${call}.family = 'shell' THEN ${anyLabel('tool_call', `${call}.id`, 'purpose')} END`

export const tokensRead = (message: string): string =>
  `(COALESCE(${message}.tokens_input, 0) + COALESCE(${message}.tokens_cache_read, 0)
     + COALESCE(${message}.tokens_cache_write, 0))`

export const activeMsOf = (session: string): string =>
  `(SELECT COALESCE(SUM(t.model_ms + t.tool_ms), 0) FROM turn t WHERE t.session_id = ${session}.id)`

export const stepsOf = (session: string): string =>
  `((SELECT COUNT(*) FROM message m WHERE m.session_id = ${session}.id AND m.actor = 'assistant')
     + (SELECT COUNT(*) FROM tool_call tc WHERE tc.session_id = ${session}.id))`

export const failedOf = (session: string): string =>
  `(SELECT COUNT(*) FROM tool_call tc WHERE tc.session_id = ${session}.id AND tc.status = 'error')`

// The reactions in the human's prompts, each from the labelling that gave its prompt the newest `act`, so a
// prompt two models labelled is read once. The cookbook stores reaction n of a prompt as `<message id>#<n>`,
// and the ids between `<id>#` and `<id>$` are that prompt's, which the label table's key finds without a scan.
export const REACTIONS = `(
  SELECT m.session_id, m.id AS message_id, r.record_id AS reaction_id, a.labeller, a.version,
    MAX(CASE WHEN r.name = 'reaction' THEN r.value END) AS reaction
  FROM label a
  JOIN message m ON m.id = a.record_id
  JOIN label r ON r.record_type = 'reaction' AND r.record_id > a.record_id || '#' AND r.record_id < a.record_id || '$'
    AND r.labeller = a.labeller AND r.version = a.version
  WHERE a.record_type = 'message' AND a.name = 'act' AND a.labelled_at = (
    SELECT MAX(a2.labelled_at) FROM label a2
    WHERE a2.record_type = 'message' AND a2.record_id = a.record_id AND a2.name = 'act')
  GROUP BY r.record_id)`

export const spawnedSessions = (sessionId: string): string =>
  `(SELECT DISTINCT c.session_id FROM turn c JOIN turn p ON p.message_id = c.parent_turn_id
     WHERE p.session_id = ${sessionId})`
