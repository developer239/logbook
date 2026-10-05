import { ERROR_CODES, LogBookError } from '@log-book/core'
import { REPLY_CODES } from '../labels/vocabularies.js'
import { labelSql } from './label-sql.js'
import { REPORT_NAMES, REPORT_NAMES_ALL, REPORT_TOPICS, type ReportName, type ReportTopic } from './report-names.js'

export interface IReportDefinition {
  topic: ReportTopic
  title: string
  description: string
  sql: string
}

// The local day of an epoch-millisecond column, for grouping and "last used".
const localDay = (column: string): string => `date(${column} / 1000, 'unixepoch', 'localtime')`

const localTime = (column: string): string => `datetime(${column} / 1000, 'unixepoch', 'localtime')`

// A model request open this long was not the model working: a wait on the human (a permission prompt, a question, or
// away), a hung request or a retry. The latency report counts these apart.
const LONG_OPEN_MESSAGE_MS = 10 * 60 * 1000

// Every session reachable from a root through subagent links, each once (a session resumed from its own descendants
// would otherwise repeat), with ambiguous links left out. A chain's tokens are its sessions' tokens summed.
const CHAIN_TOKENS_SQL = (roots: string): string => `
  WITH RECURSIVE roots(root) AS (${roots}),
  reach(root, id, depth) AS (
    SELECT root, root, 0 FROM roots
    UNION
    SELECT r.root, l.child_session_id, r.depth + 1 FROM reach r
    JOIN link l ON l.parent_session_id = r.id AND l.kind = 'subagent' AND l.confidence <> 'ambiguous'
    WHERE r.depth < 12
  ),
  members AS (SELECT DISTINCT root, id FROM reach),
  usage AS (
    SELECT m.session_id,
      SUM(COALESCE(m.tokens_input, 0) + COALESCE(m.tokens_cache_read, 0) + COALESCE(m.tokens_cache_write, 0)) AS context_read,
      SUM(COALESCE(m.tokens_output, 0)) AS output,
      MAX(COALESCE(m.tokens_input, 0) + COALESCE(m.tokens_cache_read, 0) + COALESCE(m.tokens_cache_write, 0)) AS peak
    FROM message m WHERE m.actor = 'assistant' GROUP BY m.session_id
  ),
  chains AS (
    SELECT members.root, COUNT(*) AS sessions, SUM(COALESCE(u.context_read, 0)) AS context_read,
      SUM(COALESCE(u.output, 0)) AS output, MAX(COALESCE(u.peak, 0)) AS peak,
      SUM((SELECT COUNT(*) FROM event e WHERE e.session_id = members.id AND e.kind = 'compaction')) AS compactions
    FROM members LEFT JOIN usage u ON u.session_id = members.id GROUP BY members.root
  )`

// Every reaction of the newest model labelling of each prompt, one row per reaction, with the session it was typed
// in. The labeller and version that gave a prompt its newest `act` own its reactions, so two labellers of the same
// prompt are never counted twice. A reaction's id is `<message id>#<n>`, so a prompt's reactions are the ids between
// `<id>#` and `<id>$`, which the label table's key finds without a scan.
const REACTIONS_SQL = `
  SELECT m.session_id, c.message_id, r.record_id AS reaction_id, c.labeller,
    MAX(CASE WHEN r.name = 'reaction' THEN r.value END) AS reaction,
    MAX(CASE WHEN r.name = 'about' THEN r.value END) AS about,
    MAX(CASE WHEN r.name = 'target' THEN r.value END) AS target,
    MAX(CASE WHEN r.name = 'reach' THEN r.value END) AS reach,
    MAX(CASE WHEN r.name = 'steps' THEN r.value END) AS steps
  FROM (
    SELECT a.record_id AS message_id, a.labeller, a.version FROM label a
    WHERE a.record_type = 'message' AND a.name = 'act' AND a.labelled_at = (
      SELECT MAX(a2.labelled_at) FROM label a2 WHERE a2.record_type = 'message' AND a2.record_id = a.record_id
        AND a2.name = 'act')
  ) c
  JOIN message m ON m.id = c.message_id
  JOIN label r ON r.record_type = 'reaction' AND r.record_id > c.message_id || '#' AND r.record_id < c.message_id || '$'
    AND r.labeller = c.labeller AND r.version = c.version
  GROUP BY r.record_id`

// A session's work: the first command with a command file it ran.
const SESSION_WORK_SQL = `
  SELECT c.session_id, c.command FROM session_command c
  WHERE c.has_file = 1 AND c.at = (
    SELECT MIN(c2.at) FROM session_command c2 WHERE c2.session_id = c.session_id AND c2.has_file = 1)
  GROUP BY c.session_id`

// Canned questions about how agents work, each one SQL over the warehouse. They read the harness-neutral tables
// only, so every report covers every harness the same way; `harness` columns split them where it matters. Durations
// are seconds unless a column says minutes; a tool call whose source recorded no times counts in `calls` but not in
// the duration columns. A `session` column holds a warehouse id to pass to logbook tree or logbook timeline.
export const REPORTS: Readonly<Record<ReportName, IReportDefinition>> = {
  'tool-failures': {
    topic: 'failures',
    title: 'Tools with the most failures',
    description: 'Tool calls that ended in an error, grouped by tool, with an example error.',
    sql: `SELECT s.harness, t.name, COUNT(*) AS errors, COUNT(DISTINCT t.session_id) AS sessions,
            (SELECT substr(p.text, 1, 160) FROM part p WHERE p.tool_call_id = t.id AND p.kind = 'tool_result') AS example
          FROM tool_call t JOIN session s ON s.id = t.session_id WHERE t.status = 'error'
          GROUP BY s.harness, t.name ORDER BY errors DESC LIMIT 40`,
  },
  'errors': {
    topic: 'failures',
    title: 'Failed model requests',
    description:
      'Model requests the provider or the connection failed (usage limits, context overflow, unsupported model, ' +
      'dropped connections, aborts), by error message.',
    sql: `SELECT s.harness,
            substr(COALESCE(json_extract(e.data_json, '$.error.message'), json_extract(e.data_json, '$.error'), e.data_json), 1, 140) AS error,
            COUNT(*) AS count, COUNT(DISTINCT e.session_id) AS sessions, ${localTime('MAX(e.at)')} AS last_seen
          FROM event e JOIN session s ON s.id = e.session_id WHERE e.kind = 'error'
          GROUP BY s.harness, error ORDER BY count DESC LIMIT 40`,
  },
  'shell': {
    topic: 'failures',
    title: 'Shell calls by purpose',
    description:
      "What agents use the shell for: each call's purpose from the rules where they decide it and from a model " +
      'otherwise (`unlabelled` until logbook labels run has run), with how many failed and why. Most failures are ' +
      'real results (a failing test, a type error, grep finding nothing), not mistakes; the causes come from a model ' +
      'and count only calls that failed. `written_k` is thousands of characters of command the agents wrote.',
    sql: `WITH labelled AS (
            SELECT tc.status, (tc.ended_at - tc.started_at) / 1000.0 AS duration_s,
              length(COALESCE(json_extract(tc.input_json, '$.command'), json_extract(tc.input_json, '$.cmd'))) AS chars,
              ${labelSql('tool_call', 'tc.id', 'purpose', '=')} AS rule_purpose,
              ${labelSql('tool_call', 'tc.id', 'purpose', '<>')} AS model_purpose,
              ${labelSql('tool_call', 'tc.id', 'failure', '<>')} AS failure
            FROM tool_call tc WHERE tc.family = 'shell'
          )
          SELECT COALESCE(rule_purpose, model_purpose, 'unlabelled') AS purpose, COUNT(*) AS calls,
            SUM(rule_purpose IS NOT NULL) AS by_rules, SUM(status = 'error') AS failed,
            SUM(status = 'error' AND failure = 'command mistake') AS mistakes,
            SUM(status = 'error' AND failure = 'real result') AS real_results,
            SUM(status = 'error' AND failure = 'environment') AS environment,
            SUM(status = 'error' AND failure IN ('permission', 'timeout')) AS denied_or_timeout,
            ROUND(SUM(chars) / 1000.0) AS written_k, ROUND(AVG(duration_s), 1) AS avg_s,
            ROUND(SUM(duration_s) / 60.0, 1) AS total_min
          FROM labelled GROUP BY purpose ORDER BY calls DESC`,
  },
  'tool-causes': {
    topic: 'failures',
    title: 'Why tool calls failed, outside the shell',
    description:
      "Failed calls of every tool but the shell, by cause and tool family: each call's cause from the rules, which " +
      'read the opening of its error, or from a model for the few they leave open (`unlabelled` until logbook labels ' +
      'run --task tool-failure has run, `no result` when the call recorded no error text). Missing targets and edit ' +
      "mismatches are the agent's guesses; auth, unreachable services and the environment are the host's; a tool " +
      'fault is a bug in the tool. The shell report gives shell failures.',
    sql: `WITH failed AS (
            SELECT tc.family, tc.session_id,
              COALESCE(${labelSql('tool_call', 'tc.id', 'cause', '=')}, ${labelSql('tool_call', 'tc.id', 'cause', '<>')},
                CASE WHEN EXISTS (SELECT 1 FROM part p WHERE p.tool_call_id = tc.id AND p.kind = 'tool_result'
                  AND length(trim(p.text)) > 0) THEN 'unlabelled' ELSE 'no result' END) AS cause,
              (SELECT substr(p.text, 1, 120) FROM part p WHERE p.tool_call_id = tc.id AND p.kind = 'tool_result') AS error
            FROM tool_call tc WHERE tc.status = 'error' AND tc.family <> 'shell'
          )
          SELECT cause, family, COUNT(*) AS calls, COUNT(DISTINCT session_id) AS sessions, MIN(error) AS example
          FROM failed GROUP BY cause, family ORDER BY SUM(COUNT(*)) OVER (PARTITION BY cause) DESC, cause, calls DESC`,
  },
  'repeats': {
    topic: 'failures',
    title: 'Calls repeated after failing',
    description:
      'The same tool with the same input called at least three times in one session and failing at least twice: ' +
      'an agent retrying something that does not work.',
    sql: `SELECT t.session_id AS session, t.name, substr(t.input_json, 1, 120) AS input, COUNT(*) AS attempts,
            SUM(t.status = 'error') AS errors
          FROM tool_call t GROUP BY t.session_id, t.name, t.input_json
          HAVING COUNT(*) >= 3 AND SUM(t.status = 'error') >= 2
          ORDER BY errors DESC, attempts DESC, session LIMIT 40`,
  },
  'interrupts': {
    topic: 'failures',
    title: 'Interruptions and rejected tool calls',
    description:
      'Where the human stopped the agent: the turns they interrupted and the tool calls they refused, by harness.',
    sql: `SELECT s.harness, e.kind, COUNT(*) AS count, COUNT(DISTINCT e.session_id) AS sessions,
            ${localTime('MAX(e.at)')} AS last_seen
          FROM event e JOIN session s ON s.id = e.session_id
          WHERE e.kind IN ('interrupted', 'tool-rejected')
          GROUP BY s.harness, e.kind ORDER BY count DESC, s.harness, e.kind`,
  },
  'tools': {
    topic: 'performance',
    title: 'Tools by calls, failures and time',
    description: 'Which tools are called most, fail most and take the longest.',
    sql: `SELECT s.harness, t.family, t.name, COUNT(*) AS calls,
            SUM(t.status = 'error') AS errors,
            ROUND(100.0 * SUM(t.status = 'error') / COUNT(*), 1) AS error_pct,
            COUNT(t.ended_at) AS timed,
            ROUND(AVG((t.ended_at - t.started_at) / 1000.0), 1) AS avg_s,
            ROUND(MAX((t.ended_at - t.started_at) / 1000.0), 1) AS max_s,
            ROUND(SUM((t.ended_at - t.started_at) / 1000.0) / 60.0, 1) AS total_min
          FROM tool_call t JOIN session s ON s.id = t.session_id
          GROUP BY s.harness, t.family, t.name ORDER BY calls DESC LIMIT 60`,
  },
  'slow': {
    topic: 'performance',
    title: 'Slowest tool calls',
    description:
      'The longest single tool calls, without the subagent, dispatch and wait families, which wait on other work by ' +
      'design. A call includes any wait on a permission prompt.',
    sql: `SELECT ${localTime('t.started_at')} AS at, s.harness, t.name, ROUND((t.ended_at - t.started_at) / 1000.0, 1) AS s,
            t.status, substr(t.input_json, 1, 100) AS input, t.session_id AS session
          FROM tool_call t JOIN session s ON s.id = t.session_id
          WHERE t.ended_at IS NOT NULL AND t.family NOT IN ('subagent', 'dispatch', 'wait')
          ORDER BY t.ended_at - t.started_at DESC, t.id LIMIT 40`,
  },
  'latency': {
    topic: 'performance',
    title: 'Model response time',
    description:
      'Seconds the model spent per request, and output tokens per second: from the request to its completion, less ' +
      'the time the tool calls of its message ran inside that span (overlapping calls once). A request open ten ' +
      'minutes or more is counted under over_10min instead of in the percentiles and tokens per second: a wait on ' +
      'the human (a permission prompt, a question, or away), a hung request or a retry.',
    sql: `WITH clipped AS (
            SELECT t.message_id, MAX(t.started_at, m.requested_at) AS started_at, MIN(t.ended_at, m.completed_at) AS ended_at
            FROM tool_call t JOIN message m ON m.id = t.message_id
            WHERE t.started_at IS NOT NULL AND t.ended_at IS NOT NULL
              AND m.requested_at IS NOT NULL AND m.completed_at IS NOT NULL
              AND MIN(t.ended_at, m.completed_at) > MAX(t.started_at, m.requested_at)
          ), ordered_tools AS (
            SELECT message_id, started_at, ended_at,
              MAX(ended_at) OVER (PARTITION BY message_id ORDER BY started_at, ended_at
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS covered_until
            FROM clipped
          ), tool_ms AS (
            SELECT message_id, SUM(MAX(0, ended_at - MAX(started_at, COALESCE(covered_until, started_at)))) AS ms
            FROM ordered_tools GROUP BY message_id
          ), requests AS (
            SELECT s.harness, m.model, m.actor, m.tokens_output,
              m.completed_at - m.requested_at - COALESCE(tm.ms, 0) AS ms
            FROM message m JOIN session s ON s.id = m.session_id LEFT JOIN tool_ms tm ON tm.message_id = m.id
          ), working AS (
            SELECT harness, model, tokens_output, ms,
              ROW_NUMBER() OVER (PARTITION BY harness, model ORDER BY ms) AS position,
              COUNT(*) OVER (PARTITION BY harness, model) AS total
            FROM requests WHERE actor = 'assistant' AND model IS NOT NULL AND ms > 0 AND ms < ${String(LONG_OPEN_MESSAGE_MS)}
          ), long_open AS (
            SELECT harness, model, COUNT(*) AS over_10min FROM requests
            WHERE actor = 'assistant' AND model IS NOT NULL AND ms >= ${String(LONG_OPEN_MESSAGE_MS)} GROUP BY harness, model
          )
          SELECT w.harness, w.model, COUNT(*) AS requests,
            ROUND(MIN(CASE WHEN w.position >= 0.5 * w.total THEN w.ms END) / 1000.0, 1) AS p50_s,
            ROUND(MIN(CASE WHEN w.position >= 0.9 * w.total THEN w.ms END) / 1000.0, 1) AS p90_s,
            ROUND(SUM(w.tokens_output) * 1000.0 / SUM(w.ms), 1) AS out_tokens_per_s,
            COALESCE(lo.over_10min, 0) AS over_10min
          FROM working w LEFT JOIN long_open lo ON lo.harness = w.harness AND lo.model = w.model
          GROUP BY w.harness, w.model ORDER BY requests DESC, w.model LIMIT 40`,
  },
  'turn-time': {
    topic: 'performance',
    title: 'Where turn time went',
    description:
      'Hours of turn time by harness and origin, split into model time, tool time and idle (the turn table: model ' +
      'requests outside tool time, the union of tool calls, and the rest, including any stretch with nothing ' +
      'recorded for 10 minutes). Wall-clock time counts a session waiting on background work or a sleeping machine; ' +
      'active time does not. Tool time includes waiting on subagents.',
    sql: `SELECT s.harness, s.origin, COUNT(*) AS turns,
            ROUND(SUM(t.ended_at - t.started_at) / 3600000.0, 1) AS wall_h,
            ROUND(SUM(t.model_ms + t.tool_ms) / 3600000.0, 1) AS active_h,
            ROUND(SUM(t.model_ms) / 3600000.0, 1) AS model_h, ROUND(SUM(t.tool_ms) / 3600000.0, 1) AS tool_h,
            ROUND(SUM(t.idle_ms) / 3600000.0, 1) AS idle_h,
            ROUND(100.0 * SUM(t.idle_ms) / MAX(SUM(t.ended_at - t.started_at), 1)) AS idle_pct
          FROM turn t JOIN session s ON s.id = t.session_id
          GROUP BY s.harness, s.origin ORDER BY wall_h DESC`,
  },
  'longest-turns': {
    topic: 'performance',
    title: 'Longest turns by active time',
    description:
      'The turns that kept the model and tools busy longest, with the idle time their wall-clock duration also ' +
      'holds; ranking by duration instead puts turns that mostly waited first. `session` opens in logbook tree or ' +
      'logbook timeline.',
    sql: `SELECT ${localTime('t.started_at')} AS started, s.harness, s.origin,
            ROUND((t.model_ms + t.tool_ms) / 60000.0, 1) AS active_min, ROUND(t.model_ms / 60000.0, 1) AS model_min,
            ROUND(t.tool_ms / 60000.0, 1) AS tool_min, ROUND(t.idle_ms / 60000.0, 1) AS idle_min,
            ROUND((t.ended_at - t.started_at) / 60000.0, 1) AS wall_min, t.requests, t.tool_calls,
            (SELECT substr(replace(p.text, char(10), ' '), 1, 70) FROM part p
              WHERE p.message_id = t.message_id AND p.kind = 'text' ORDER BY p.idx LIMIT 1) AS prompt,
            t.session_id AS session
          FROM turn t JOIN session s ON s.id = t.session_id
          ORDER BY t.model_ms + t.tool_ms DESC LIMIT 30`,
  },
  'heavy': {
    topic: 'performance',
    title: 'Heaviest sessions',
    description:
      'Sessions by output tokens, with wall-clock and tool time in minutes, the largest context a request carried ' +
      '(thousands of tokens), compactions and failed tool calls.',
    sql: `SELECT s.id AS session, s.harness, s.origin, substr(s.title, 1, 50) AS title, ${localDay('s.started_at')} AS day,
            ROUND((s.ended_at - s.started_at) / 60000.0) AS min,
            (SELECT ROUND(SUM(t.ended_at - t.started_at) / 60000.0, 1) FROM tool_call t WHERE t.session_id = s.id) AS tool_min,
            (SELECT COUNT(*) FROM tool_call t WHERE t.session_id = s.id) AS tools,
            (SELECT COUNT(*) FROM tool_call t WHERE t.session_id = s.id AND t.status = 'error') AS failed,
            (SELECT SUM(m.tokens_output) FROM message m WHERE m.session_id = s.id) AS out_tokens,
            (SELECT ROUND(MAX(m.tokens_input + COALESCE(m.tokens_cache_read, 0) + COALESCE(m.tokens_cache_write, 0)) / 1000.0)
              FROM message m WHERE m.session_id = s.id) AS peak_context_k,
            (SELECT COUNT(*) FROM event e WHERE e.session_id = s.id AND e.kind = 'compaction') AS compactions
          FROM session s ORDER BY out_tokens DESC, s.id LIMIT 30`,
  },
  'output': {
    topic: 'performance',
    title: 'Tool output size',
    description:
      'How much text each tool hands back to the model, the context every call costs (characters; about four per token).',
    sql: `SELECT s.harness, t.name, COUNT(*) AS results, ROUND(AVG(length(p.text))) AS avg_chars,
            MAX(length(p.text)) AS max_chars, ROUND(SUM(length(p.text)) / 1e6, 1) AS total_mchars
          FROM part p JOIN tool_call t ON t.id = p.tool_call_id JOIN session s ON s.id = t.session_id
          WHERE p.kind = 'tool_result'
          GROUP BY s.harness, t.name ORDER BY SUM(length(p.text)) DESC LIMIT 40`,
  },
  'skills': {
    topic: 'usage',
    title: 'Skills loaded',
    description: 'Which skills agents load, in how many sessions, and when last.',
    sql: `SELECT s.harness, COALESCE(json_extract(t.input_json, '$.skill'), json_extract(t.input_json, '$.name')) AS skill,
            COUNT(*) AS loads, COUNT(DISTINCT t.session_id) AS sessions, SUM(t.status = 'error') AS errors,
            ${localDay('MAX(m.created_at)')} AS last_used
          FROM tool_call t JOIN session s ON s.id = t.session_id JOIN message m ON m.id = t.message_id
          WHERE t.family = 'skill'
          GROUP BY s.harness, skill ORDER BY loads DESC LIMIT 60`,
  },
  'commands': {
    topic: 'usage',
    title: 'Commands',
    description:
      'The commands sessions ran, by how they came (typed, or a template the harness expanded), with how often and ' +
      'when last, and whether a command file holds them.',
    sql: `SELECT c.source AS via, s.harness, c.command, MAX(c.has_file) AS has_file, COUNT(*) AS uses,
            ${localDay('MAX(c.at)')} AS last_used
          FROM session_command c JOIN session s ON s.id = c.session_id
          GROUP BY c.source, s.harness, c.command ORDER BY uses DESC, c.command LIMIT 60`,
  },
  'families': {
    topic: 'usage',
    title: 'Tool families',
    description:
      'Calls per tool family (built-in groups, and each MCP server as mcp:<server>), with how many distinct tools and ' +
      'sessions used them and when last.',
    sql: `SELECT t.family, s.harness, COUNT(*) AS calls, COUNT(DISTINCT t.name) AS tools,
            COUNT(DISTINCT t.session_id) AS sessions, SUM(t.status = 'error') AS errors,
            ${localDay('MAX(m.created_at)')} AS last_used
          FROM tool_call t JOIN session s ON s.id = t.session_id JOIN message m ON m.id = t.message_id
          GROUP BY t.family, s.harness ORDER BY calls DESC LIMIT 60`,
  },
  'models': {
    topic: 'usage',
    title: 'Model requests and tokens',
    description:
      'Assistant messages and tokens per model; reported cost is what the provider said (0 on a subscription).',
    sql: `SELECT s.harness, m.model, COUNT(*) AS messages, SUM(m.tokens_input) AS input, SUM(m.tokens_output) AS output,
            SUM(m.tokens_reasoning) AS reasoning, SUM(m.tokens_cache_read) AS cache_read,
            SUM(m.tokens_cache_write) AS cache_write, ROUND(SUM(m.reported_cost), 2) AS reported_cost
          FROM message m JOIN session s ON s.id = m.session_id
          WHERE m.actor = 'assistant' GROUP BY s.harness, m.model ORDER BY messages DESC LIMIT 40`,
  },
  'daily': {
    topic: 'usage',
    title: 'Activity per day',
    description: 'Sessions started, human prompts and tool calls per day and harness.',
    sql: `WITH started AS (
            SELECT ${localDay('started_at')} AS day, harness, COUNT(*) AS sessions, SUM(origin = 'interactive') AS interactive
            FROM session WHERE started_at IS NOT NULL GROUP BY day, harness
          ), prompts AS (
            SELECT ${localDay('m.created_at')} AS day, x.harness, COUNT(*) AS prompts
            FROM message m JOIN session x ON x.id = m.session_id
            WHERE x.origin = 'interactive' AND m.actor = 'user' GROUP BY day, x.harness
          ), calls AS (
            SELECT ${localDay('cm.created_at')} AS day, x.harness, COUNT(*) AS tool_calls
            FROM tool_call t JOIN session x ON x.id = t.session_id JOIN message cm ON cm.id = t.message_id
            GROUP BY day, x.harness
          )
          SELECT started.day, started.harness, started.sessions, started.interactive,
            COALESCE(prompts.prompts, 0) AS prompts, COALESCE(calls.tool_calls, 0) AS tool_calls
          FROM started LEFT JOIN prompts USING (day, harness) LEFT JOIN calls USING (day, harness)
          ORDER BY started.day DESC, started.harness LIMIT 60`,
  },
  'calls': {
    topic: 'sessions',
    title: 'Who calls whom',
    description:
      'Every caller and callee pair: a session (harness and agent) that started subagents, what it started (harness, ' +
      'agent, model), how often, and how long they took (minutes). Ambiguous links are left out.',
    sql: `SELECT ps.harness || COALESCE(' ' || ps.agent, '') AS caller, l.kind,
            cs.harness || COALESCE(' ' || cs.agent, '') AS callee,
            (SELECT m.model FROM message m WHERE m.session_id = cs.id AND m.model IS NOT NULL ORDER BY m.seq LIMIT 1) AS model,
            COUNT(*) AS count, ROUND(AVG(cs.ended_at - cs.started_at) / 60000.0, 1) AS avg_min
          FROM link l JOIN session ps ON ps.id = l.parent_session_id JOIN session cs ON cs.id = l.child_session_id
          WHERE l.confidence <> 'ambiguous'
          GROUP BY caller, l.kind, callee, model ORDER BY count DESC LIMIT 50`,
  },
  'chains': {
    topic: 'sessions',
    title: 'Sessions that started the most others',
    description: 'Sessions by the subagents they started directly. Pass a session to logbook tree for the whole chain.',
    sql: `SELECT p.id AS session, p.harness, substr(p.title, 1, 50) AS title, ${localDay('p.started_at')} AS day,
            COUNT(*) AS subagents
          FROM link l JOIN session p ON p.id = l.parent_session_id
          WHERE l.kind = 'subagent' AND l.confidence <> 'ambiguous'
          GROUP BY p.id ORDER BY COUNT(*) DESC, p.id LIMIT 30`,
  },
  'work': {
    topic: 'sessions',
    title: 'Work by command',
    description:
      'Sessions by the first command with a command file they ran, with what a piece of such work costs in tokens ' +
      'across its whole chain (the session and every subagent it started): context read summed over requests, output, ' +
      'and the fullest single request, in thousands; plus how often the human corrected the agent in those sessions ' +
      '(logbook labels run --task prompt).',
    sql: `${CHAIN_TOKENS_SQL(`SELECT session_id FROM (${SESSION_WORK_SQL})`)}
          SELECT g.command, COUNT(*) AS sessions, ROUND(AVG(c.sessions), 1) AS avg_chain_sessions,
            ROUND(AVG(c.context_read) / 1000.0) AS avg_context_read_k, ROUND(MAX(c.context_read) / 1000.0) AS max_context_read_k,
            ROUND(AVG(c.output) / 1000.0, 1) AS avg_output_k, ROUND(AVG(c.peak) / 1000.0) AS avg_peak_k,
            SUM(c.compactions) AS compactions,
            (SELECT COUNT(*) FROM (${REACTIONS_SQL}) k WHERE k.reaction = 'correction'
              AND k.session_id IN (SELECT session_id FROM (${SESSION_WORK_SQL}) x WHERE x.command = g.command)) AS corrections
          FROM (${SESSION_WORK_SQL}) g JOIN chains c ON c.root = g.session_id
          GROUP BY g.command ORDER BY sessions DESC, g.command LIMIT 40`,
  },
  'goals': {
    topic: 'sessions',
    title: 'Sessions by goal',
    description:
      'What sessions were for, by the goal a model gave each one (logbook labels run --task session; `unlabelled` ' +
      "until it has run), counted by first goal: who started them, what they cost in tokens (each session's own " +
      'requests, not its chain), how often the human corrected the agent, pushed back or praised it in them (logbook ' +
      'labels run --task prompt), and their failed tool calls. A goal and the command that started a session can ' +
      'differ: the work report goes by the command.',
    sql: `WITH goals AS (
            SELECT s.id, s.origin, COALESCE(${labelSql('session', 's.id', 'goal', '<>')}, 'unlabelled') AS goal,
              (SELECT COUNT(*) FROM tool_call t WHERE t.session_id = s.id AND t.status = 'error') AS tool_errors
            FROM session s
          ),
          usage AS (
            SELECT m.session_id,
              SUM(COALESCE(m.tokens_input, 0) + COALESCE(m.tokens_cache_read, 0) + COALESCE(m.tokens_cache_write, 0)) AS context_read,
              SUM(COALESCE(m.tokens_output, 0)) AS output,
              MAX(COALESCE(m.tokens_input, 0) + COALESCE(m.tokens_cache_read, 0) + COALESCE(m.tokens_cache_write, 0)) AS peak
            FROM message m WHERE m.actor = 'assistant' GROUP BY m.session_id
          ),
          reactions AS (
            SELECT session_id, SUM(reaction = 'correction') AS corrections, SUM(reaction = 'pushback') AS pushbacks,
              SUM(reaction = 'praise') AS praise
            FROM (${REACTIONS_SQL}) GROUP BY session_id
          )
          SELECT g.goal, COUNT(*) AS sessions, SUM(g.origin = 'interactive') AS by_human,
            SUM(g.origin <> 'interactive') AS by_agent,
            ROUND(SUM(COALESCE(u.context_read, 0)) / 1000000.0, 1) AS context_read_m,
            ROUND(SUM(COALESCE(u.output, 0)) / 1000.0) AS output_k, ROUND(AVG(u.peak) / 1000.0) AS avg_peak_k,
            SUM(COALESCE(r.corrections, 0)) AS corrections, SUM(COALESCE(r.pushbacks, 0)) AS pushbacks,
            SUM(COALESCE(r.praise, 0)) AS praise, SUM(g.tool_errors) AS tool_errors
          FROM goals g LEFT JOIN usage u ON u.session_id = g.id LEFT JOIN reactions r ON r.session_id = g.id
          GROUP BY g.goal ORDER BY sessions DESC`,
  },
  'outcomes': {
    topic: 'sessions',
    title: 'How sessions ended, by goal',
    description:
      'Each session by its first goal and who started it, with how a model judged it ended (logbook labels run ' +
      '--task outcome; `unlabelled` until it has run): done, partly done, handed off, blocked, failed, abandoned, no ' +
      'task or unclear. `done_pct` is the share done of the sessions that had a task and a clear end.',
    sql: `WITH judged AS (
            SELECT CASE s.origin WHEN 'interactive' THEN 'human' ELSE 'agent' END AS started_by,
              COALESCE(${labelSql('session', 's.id', 'goal', '<>')}, 'unlabelled') AS goal,
              COALESCE(${labelSql('session', 's.id', 'outcome', '<>')}, 'unlabelled') AS outcome
            FROM session s
          )
          SELECT goal, started_by, COUNT(*) AS sessions, SUM(outcome = 'done') AS done,
            SUM(outcome = 'partly done') AS partly, SUM(outcome = 'handed off') AS handed_off,
            SUM(outcome = 'blocked') AS blocked, SUM(outcome = 'failed') AS failed,
            SUM(outcome = 'abandoned') AS abandoned, SUM(outcome = 'unclear') AS unclear,
            ROUND(100.0 * SUM(outcome = 'done')
              / NULLIF(SUM(outcome NOT IN ('no task', 'unclear', 'unlabelled')), 0)) AS done_pct
          FROM judged GROUP BY goal, started_by ORDER BY SUM(COUNT(*)) OVER (PARTITION BY goal) DESC, goal, started_by`,
  },
  'context': {
    topic: 'performance',
    title: 'Biggest chains by context',
    description:
      'The interactive sessions whose chains (the session and every subagent it started) read the most context, in ' +
      'thousands of tokens: context read summed over requests, output, the fullest single request, compactions, and ' +
      'the first command with a command file the session ran.',
    sql: `${CHAIN_TOKENS_SQL(`SELECT id FROM session WHERE origin = 'interactive'`)}
          SELECT c.root AS session, substr(s.title, 1, 50) AS title, ${localDay('s.started_at')} AS day,
            (SELECT g.command FROM (${SESSION_WORK_SQL}) g WHERE g.session_id = c.root) AS command,
            c.sessions, ROUND(c.context_read / 1000.0) AS context_read_k, ROUND(c.output / 1000.0, 1) AS output_k,
            ROUND(c.peak / 1000.0) AS peak_k, c.compactions
          FROM chains c JOIN session s ON s.id = c.root
          ORDER BY c.context_read DESC, c.root LIMIT 30`,
  },
  'links': {
    topic: 'sessions',
    title: 'How sessions are linked',
    description: 'Sessions by origin, and links by kind and confidence.',
    sql: `SELECT 'session origin' AS what, origin AS value, COUNT(*) AS count FROM session GROUP BY origin
          UNION ALL SELECT 'link ' || kind, confidence, COUNT(*) FROM link GROUP BY kind, confidence`,
  },
  'recovery': {
    topic: 'failures',
    title: 'Failed calls the agent got past',
    description:
      'Failed tool calls by family: how many the agent recovered from (a later call of the same tool, with the ' +
      'same purpose for the shell, succeeded before the next human prompt), and how many a reaction of the human ' +
      'named as a step it was about (logbook labels run --task prompt).',
    sql: `WITH named AS (
            SELECT DISTINCT j.value AS id FROM (${REACTIONS_SQL}) r,
              json_each('["' || replace(r.steps, ',', '","') || '"]') j
            WHERE r.steps IS NOT NULL
          )
          SELECT tc.family, COUNT(*) AS failed,
            SUM(${labelSql('tool_call', 'tc.id', 'recovery', '=')} = 'recovered') AS recovered,
            ROUND(100.0 * SUM(${labelSql('tool_call', 'tc.id', 'recovery', '=')} = 'recovered') / COUNT(*)) AS recovered_pct,
            SUM(tc.id IN (SELECT id FROM named)) AS named_in_a_reaction
          FROM tool_call tc WHERE tc.status = 'error'
          GROUP BY tc.family ORDER BY failed DESC LIMIT 40`,
  },
  'reactions': {
    topic: 'interaction',
    title: 'How the human reacted to the agent',
    description:
      "The reactions in the human's prompts (logbook labels run --task prompt), by kind and what they concern: " +
      'corrections (the agent got it wrong), pushback (a defensible choice the human wanted otherwise), ' +
      'clarifications, redirects (the human changed course), praise and teaching (a standing preference), with how ' +
      'far the human meant each.',
    sql: `SELECT r.reaction, r.target, COUNT(*) AS count, SUM(r.reach = 'once') AS once,
            SUM(r.reach = 'project') AS project, SUM(r.reach = 'everywhere') AS everywhere,
            COUNT(DISTINCT r.session_id) AS sessions, ${localDay('MAX(m.created_at)')} AS last_seen
          FROM (${REACTIONS_SQL}) r JOIN message m ON m.id = r.message_id
          GROUP BY r.reaction, r.target
          ORDER BY SUM(COUNT(*)) OVER (PARTITION BY r.reaction) DESC, r.reaction, count DESC`,
  },
  'replies': {
    topic: 'interaction',
    title: 'What the agent did in its replies',
    description:
      'The reply that ends each turn of an interactive session (logbook labels run --task reply), by harness and ' +
      'model: how often it pushed back, corrected the human, held or dropped a position, asked, asked permission, ' +
      'claimed done with and without a check, admitted a mistake, listed options without a pick, or disclosed a gap.',
    sql: `WITH replies AS (
            SELECT l.record_id, l.value FROM label l
            WHERE l.record_type = 'message' AND l.name = 'reply' AND l.labelled_at = (
              SELECT MAX(l2.labelled_at) FROM label l2
              WHERE l2.record_type = 'message' AND l2.record_id = l.record_id AND l2.name = 'reply')
          )
          SELECT s.harness, COALESCE(m.model, 'unknown') AS model, COUNT(*) AS replies,
            ${REPLY_CODES.map((code) => `SUM(instr(',' || v.value || ',', ',${code},') > 0) AS ${code}`).join(', ')}
          FROM replies v JOIN message m ON m.id = v.record_id JOIN session s ON s.id = m.session_id
          GROUP BY s.harness, model ORDER BY replies DESC`,
  },
}

const invalidSelector = (selector: string): LogBookError =>
  new LogBookError(
    `Unknown report ${selector}. Topics: ${REPORT_TOPICS.join(', ')}. Reports: ${REPORT_NAMES.join(', ')}.`,
    ERROR_CODES.VALIDATION_ERROR
  )

// The reports a selector names: a report name, a topic (every report in it) or `all`, in the order `all` prints them.
export const reportsFor = (selector: string): ReportName[] => {
  if (selector === REPORT_NAMES_ALL) {
    return [...REPORT_NAMES]
  }
  if ((REPORT_TOPICS as readonly string[]).includes(selector)) {
    return REPORT_NAMES.filter((name) => REPORTS[name].topic === selector)
  }
  const name = REPORT_NAMES.find((candidate) => candidate === selector)
  if (name === undefined) {
    throw invalidSelector(selector)
  }
  return [name]
}
