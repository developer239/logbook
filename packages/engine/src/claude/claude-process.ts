import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSubprocess, type ISubprocessResult } from '@log-book/core'

// Every `claude` process the engine starts runs with the parent environment as it is, nothing removed or filtered, so
// a user who points Claude Code at another provider through its own variables keeps that; plus no thinking and no
// traffic beyond the request.
const claudeEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  MAX_THINKING_TOKENS: '0',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
})

export interface IClaudeRun {
  binary: string
  args: string[]
  // The fresh directory of `inLabelDirectory`.
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
  input?: string
}

export const runClaude = async ({
  binary,
  args,
  cwd,
  timeoutMs,
  signal,
  input,
}: IClaudeRun): Promise<ISubprocessResult> =>
  runSubprocess({
    command: binary,
    args,
    timeoutMs,
    label: 'claude',
    env: claudeEnvironment(),
    cwd,
    ...(signal === undefined ? {} : { signal }),
    ...(input === undefined ? {} : { input }),
  })

// A fresh empty working directory, mode 0700, for the `claude` processes of `work`, removed when it ends, so no
// project's CLAUDE.md, settings or git state can be read from it.
export const inLabelDirectory = async <TResult>(work: (directory: string) => Promise<TResult>): Promise<TResult> => {
  const directory = await mkdtemp(join(tmpdir(), 'logbook-label-'))
  try {
    return await work(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
