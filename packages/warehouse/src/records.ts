// The records adapters and the engine hand to the store: camelCase fields mirroring the columns, with boolean for an
// is_ or has_ column. They are not rows. An adapter turns one source unit into these shapes; nothing downstream of it
// knows which harness a record came from except through the `harness` field. A session id is
// `<harness>:<source id>`, so ids from different harnesses never collide, and the id of a message, tool call or event
// is `<session id>/<source id>`, because a resumed or forked session can repeat a source id. Times are epoch
// milliseconds, and a time the source does not record is null, never estimated.

// How a session began: typed by the human, started by a program (a script or tool calling the harness
// non-interactively), or by a subagent call inside its parent session.
export type SessionOrigin = 'interactive' | 'scripted' | 'subagent'

// `user` is whoever wrote the prompt: the human in an interactive session, the dispatching agent in a session a
// program or a subagent call started. `tool` carries tool results, `harness` everything the harness injected
// (instructions, compaction summaries, reminders).
export type MessageActor = 'user' | 'assistant' | 'tool' | 'harness'

export type PartKind = 'text' | 'reasoning' | 'tool_call' | 'tool_result' | 'compaction'

export type ToolCallStatus = 'completed' | 'error' | 'pending'

export type SessionEventKind =
  | 'compaction'
  | 'model-switched'
  | 'agent-switched'
  | 'idle'
  // A model request that failed (provider error, usage limit, dropped connection).
  | 'error'
  // The tools the harness offers changed: the whole set at the start, then each MCP server that connects, fails or
  // drops.
  | 'tools-offered'
  // The definitions the harness added to the context: tools sent at the start or loaded on demand.
  | 'tools-loaded'
  // A skill the session loaded.
  | 'skill-loaded'
  // The human interrupted the assistant.
  | 'interrupted'
  // The human refused a tool call.
  | 'tool-rejected'
  // An entry type the adapter does not know, kept so it shows up in queries instead of vanishing.
  | 'unknown'

// `exact` comes from an id both sides recorded; `reconstructed` from one unambiguous match on weaker evidence (an id
// in a tool result, a time window); `ambiguous` marks each of several candidates the evidence could not choose between.
export type LinkConfidence = 'exact' | 'reconstructed' | 'ambiguous'

export type LinkKind = 'subagent'

// Typed by name, or recognised by its expanded body.
export type SessionCommandSource = 'typed' | 'template'

// A message is a prompt or a reply; a reaction is one entry of a prompt, `<message id>#<n>`.
export type LabelRecordType = 'tool_call' | 'session' | 'message' | 'reaction'

export interface ISessionRecord {
  id: string
  // The id of the adapter that imported the session.
  harness: string
  sourceId: string
  // Set by the link pass from the session's incoming links and `isScripted`; `interactive` until either says
  // otherwise.
  origin: SessionOrigin
  // The source itself shows a program started the session.
  isScripted: boolean
  projectDir: string | null
  title: string | null
  // The agent the session ran as, when the source names one.
  agent: string | null
  // A subagent session's parent session and the tool call that started it; null for every other session.
  spawnedBySessionId: string | null
  spawnedByToolCallId: string | null
  startedAt: number | null
  endedAt: number | null
}

export interface IMessageRecord {
  id: string
  sessionId: string
  seq: number
  actor: MessageActor
  // The role or entry type the source used, kept for queries the actor hides.
  sourceRole: string
  createdAt: number
  completedAt: number | null
  // When the model request that produced the message was sent, when the source records it.
  requestedAt: number | null
  model: string | null
  agent: string | null
  gitBranch: string | null
  tokensInput: number | null
  tokensOutput: number | null
  tokensReasoning: number | null
  tokensCacheRead: number | null
  tokensCacheWrite: number | null
  // What the provider reported. A subscription reports 0, which is not a price.
  reportedCost: number | null
}

export interface IPartRecord {
  messageId: string
  sessionId: string
  idx: number
  kind: PartKind
  text: string
  // For tool_call and tool_result parts.
  toolCallId: string | null
}

export interface IToolCallRecord {
  id: string
  sessionId: string
  messageId: string
  // The name as the harness recorded it.
  name: string
  // The name without its server's prefix.
  bareName: string
  // The MCP server that offers the tool; null for a built-in tool.
  server: string | null
  // A coarse grouping for queries, one of the adapter contract's tool families; the exact name stays in `name`.
  family: string
  inputJson: string
  status: ToolCallStatus
  // The session the call started, when its source says so (a subagent call).
  childSessionId: string | null
  startedAt: number | null
  endedAt: number | null
}

export interface IEventRecord {
  id: string
  sessionId: string
  kind: SessionEventKind
  at: number
  dataJson: string
}

// Everything an adapter read about one source unit, written as a unit: the store replaces whatever it held for the
// session with this.
export interface IImportedSession {
  session: ISessionRecord
  messages: IMessageRecord[]
  parts: IPartRecord[]
  toolCalls: IToolCallRecord[]
  events: IEventRecord[]
}

export interface ILinkRecord {
  parentSessionId: string
  parentToolCallId: string | null
  childSessionId: string
  kind: LinkKind
  confidence: LinkConfidence
  evidence: string
}

// A command a session ran.
export interface ISessionCommandRecord {
  sessionId: string
  // The prompt that ran it.
  messageId: string
  at: number
  command: string
  source: SessionCommandSource
  // The command has a file of its own; false for a harness command with no file (such as /model or /clear).
  hasFile: boolean
}

// How one turn spent its time, derived from the messages and tool calls on every sync. A turn starts at a user
// message, or at a session's first message whoever wrote it (`isPrompt` false).
export interface ITurnRecord {
  sessionId: string
  // The turn's first message, which is also the turn's id.
  messageId: string
  seq: number
  isPrompt: boolean
  requests: number
  toolCalls: number
  startedAt: number
  endedAt: number
  modelMs: number
  toolMs: number
  idleMs: number
  // The part of idleMs a tool spent waiting for the human to answer.
  humanWaitMs: number
  // Where a turn of a started session sits: the turn that started it and, when known, the tool call. Null for a
  // turn no call placed.
  parentTurnId: string | null
  parentToolCallId: string | null
}

// One field of the label a labeller gave a record: rules computed on every sync, or a model's answer, which is kept.
// A record has a row per field, and one set of rows per labeller and version.
export interface ILabelRecord {
  recordType: LabelRecordType
  recordId: string
  labeller: string
  version: number
  name: string
  value: string
  labelledAt: number
}

// What a sync records about one source unit it imported: the adapter's fingerprint and parser version, so the next
// sync can tell whether the unit changed, and when it was imported.
export interface ISourceStateRecord {
  harness: string
  locator: string
  fingerprint: string
  parserVersion: number
  importedAt: number
}

// What a sync knows about one registered adapter when it starts: the harness's name and filter alias, whether its
// data is on this machine, and where it is or where the adapter looked (null when it could not say). Locations
// arrive in their `~/` form.
export interface IHarnessDescriptorRecord {
  id: string
  name: string
  defaultAgent: string
  filterAlias: string
  isFound: boolean
  checkedAt: number
  location: string | null
  // The harness's own environment variables that move its data, by name.
  locationVariables: string[]
}

// What one adapter's step of a sync ended with; null means none.
export interface IHarnessStepRecord {
  // The newest harness version the step's imported units recorded.
  versionSeen: string | null
  // The engine's drift notice, up to two sentences.
  notice: string | null
  // The message of the error that ended the step.
  problem: string | null
}

// `partial`: the sync finished but an adapter's step failed or a unit was skipped; `stopped`: SIGINT or SIGTERM.
export type SyncOutcome = 'ok' | 'partial' | 'failed' | 'stopped'

export interface ISyncEndRecord {
  endedAt: number
  outcome: SyncOutcome
  // The first problem line for `partial`, the last line of the ending error for `failed`, null otherwise.
  error: string | null
}

// One task a labelling run runs, as the engine names it, with the label version of its rows and the records it plans to
// label.
export interface ILabelRunTaskRecord {
  task: string
  version: number
  planned: number
}

export interface ILabelRunStartRecord {
  // The labelling process's, the pid it writes into the labelling lock.
  pid: number
  startedAt: number
  // Exactly the labeller of the labels the run writes.
  model: string
  tasks: readonly ILabelRunTaskRecord[]
}

// `limit`: the usage or spend limit; `unreachable`: Claude Code could not reach its API.
export type LabelRunOutcome = 'ok' | 'stopped' | 'limit' | 'unreachable' | 'failed'

export interface ILabelRunEndRecord {
  endedAt: number
  outcome: LabelRunOutcome
  // The message the run ended with for `limit`, `unreachable` and `failed`, null for `ok` and `stopped`.
  error: string | null
}
