// The text a failure value carries: Claude Code's own, cut to its last characters, never the batch prompt.
const DETAIL_CHARS = 300
const USAGE_LIMIT_STATUS = 429
const AUTHENTICATION_STATUS = 401
const USAGE_LIMIT_TEXT = /You've hit your .*limit/u
// `Connection dropped` is how Claude Code 2.1.286 reports a connection the API ended without an answer.
const UNREACHABLE_TEXT = /No response from API|ENOTFOUND|Connection dropped/u
const PROMPT_TOO_LONG_REASON = 'blocking_limit'
const PROMPT_TOO_LONG_TEXT = /Prompt is too long/u

interface IBatchUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

// Why a stop stops: `authentication` and `binary-missing` are missing prerequisites.
export type BatchStopCause = 'limit' | 'unreachable' | 'authentication' | 'binary-missing' | 'error' | 'no-result'

// Every way a batch call ends, as a value: an answer; a batch too long to answer, retried in small batches; a timeout,
// which leaves the batch unanswered while the run continues; the run's own abort; or a stop after the batches in
// flight, with the run's outcome.
export type BatchResult =
  | { readonly type: 'answer'; readonly text: string; readonly usage: IBatchUsage }
  | { readonly type: 'too-long'; readonly detail: string }
  | { readonly type: 'timeout'; readonly detail: string }
  | { readonly type: 'aborted' }
  | {
      readonly type: 'stop'
      readonly outcome: 'limit' | 'unreachable' | 'failed'
      readonly cause: BatchStopCause
      readonly isMissingPrerequisite: boolean
      // For `no-result`, the exit code of a process that ended without a result object.
      readonly exitCode: number | null
      readonly detail: string
    }

interface ITerminalResult {
  is_error: boolean
  api_error_status?: unknown
  terminal_reason?: unknown
  result?: unknown
  usage?: unknown
}

export const detailOf = (text: string): string => text.trim().slice(-DETAIL_CHARS)

const isTerminalResult = (value: unknown): value is ITerminalResult =>
  typeof value === 'object' && value !== null && typeof (value as { is_error?: unknown }).is_error === 'boolean'

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

// The terminal result object on stdout: the whole output as one object, or the last line that is one.
const terminalResultOf = (stdout: string): ITerminalResult | null => {
  const candidates = [
    stdout.trim(),
    ...stdout
      .split('\n')
      .map((line) => line.trim())
      .toReversed(),
  ]
  for (const candidate of candidates.filter((text) => text.startsWith('{'))) {
    const value = parsed(candidate)
    if (isTerminalResult(value)) {
      return value
    }
  }
  return null
}

const usageOf = (usage: unknown): IBatchUsage => {
  const count = (name: string): number => {
    const value = typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>)[name] : undefined
    return typeof value === 'number' ? value : 0
  }
  return {
    inputTokens: count('input_tokens'),
    outputTokens: count('output_tokens'),
    cacheReadTokens: count('cache_read_input_tokens'),
    cacheWriteTokens: count('cache_creation_input_tokens'),
  }
}

const stop = (
  outcome: 'limit' | 'unreachable' | 'failed',
  cause: BatchStopCause,
  detail: string,
  exitCode: number | null = null
): BatchResult => ({
  type: 'stop',
  outcome,
  cause,
  isMissingPrerequisite: cause === 'authentication' || cause === 'binary-missing',
  exitCode,
  detail: detailOf(detail),
})

// An error result, by the first row of the classification that matches.
const classifyError = (result: ITerminalResult): BatchResult => {
  const text = typeof result.result === 'string' ? result.result : ''
  if (result.api_error_status === USAGE_LIMIT_STATUS || USAGE_LIMIT_TEXT.test(text)) {
    return stop('limit', 'limit', text)
  }
  if (UNREACHABLE_TEXT.test(text)) {
    return stop('unreachable', 'unreachable', text)
  }
  if (result.api_error_status === AUTHENTICATION_STATUS) {
    return stop('failed', 'authentication', text)
  }
  if (result.terminal_reason === PROMPT_TOO_LONG_REASON || PROMPT_TOO_LONG_TEXT.test(text)) {
    return { type: 'too-long', detail: detailOf(text) }
  }
  return stop('failed', 'error', text)
}

// A finished `claude -p` call, read from its terminal result object and never from other output.
export const classifyBatchOutput = (stdout: string, stderr: string, exitCode: number): BatchResult => {
  const result = terminalResultOf(stdout)
  if (result === null) {
    return stop('failed', 'no-result', stderr, exitCode)
  }
  if (result.is_error) {
    return classifyError(result)
  }
  return { type: 'answer', text: typeof result.result === 'string' ? result.result : '', usage: usageOf(result.usage) }
}
