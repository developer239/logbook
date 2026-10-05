import { ERROR_CODES, isErrnoCode, LogBookError } from '@log-book/core'
import { classifyBatchOutput, detailOf, type BatchResult } from './batch-result.js'
import { runClaude } from './claude-process.js'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export interface ILabelBatchCall {
  binary: string
  // The run's labelling model.
  model: string
  // The task's one-line system text.
  systemPrompt: string
  // The batch prompt, written on stdin.
  prompt: string
  // The run's working directory.
  cwd: string
  signal: AbortSignal
  timeoutMs?: number
}

// The flags of every labelling call. `--system-prompt` replaces Claude Code's own, so no coding-agent instructions are
// sent; `--tools ''`, `--strict-mcp-config` and `--disable-slash-commands` keep every tool, MCP server and skill out of
// the request; `--no-session-persistence` keeps the call out of the user's sessions and the next sync;
// `--setting-sources local` skips the user's settings, global CLAUDE.md and hooks while the login still works. No
// `--json-schema`: structured output made the model write its answer twice.
const argsOf = (model: string, systemPrompt: string): string[] => [
  '-p',
  '--model',
  model,
  '--system-prompt',
  systemPrompt,
  '--tools',
  '',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--setting-sources',
  'local',
  '--output-format',
  'json',
]

const failureOf = (error: unknown): BatchResult => {
  if (!(error instanceof LogBookError)) {
    throw error
  }
  if (error.code === ERROR_CODES.TIMEOUT) {
    return { type: 'timeout', detail: detailOf(error.message) }
  }
  if (error.code === ERROR_CODES.ABORTED) {
    return { type: 'aborted' }
  }
  const isMissing = isErrnoCode(error.cause, 'ENOENT')
  return {
    type: 'stop',
    outcome: 'failed',
    cause: isMissing ? 'binary-missing' : 'error',
    isMissingPrerequisite: isMissing,
    exitCode: null,
    detail: detailOf(error.message),
  }
}

// One labelling batch: one `claude -p` process with the prompt on stdin and nothing on the command line but flags, a
// model id and a one-line system text. Every way it can end comes back classified, never thrown, so the runner can
// tell "unanswered, continue" from "stop after the batches in flight" and keep what it has.
export const runLabelBatch = async (call: ILabelBatchCall): Promise<BatchResult> => {
  try {
    const { stdout, stderr, exitCode } = await runClaude({
      binary: call.binary,
      args: argsOf(call.model, call.systemPrompt),
      cwd: call.cwd,
      timeoutMs: call.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: call.signal,
      input: call.prompt,
    })
    return classifyBatchOutput(stdout, stderr, exitCode)
  } catch (error: unknown) {
    return failureOf(error)
  }
}
