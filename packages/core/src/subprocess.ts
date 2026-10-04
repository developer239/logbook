import { spawn } from 'node:child_process'
import { ERROR_CODES, LogBookError } from './errors.js'

export interface IRunSubprocessOptions {
  // Executable to spawn. Resolved via PATH unless an absolute path is given.
  command: string
  // Argument vector, passed verbatim to spawn() - no shell interpretation.
  args: string[]
  // Wall-clock bound. On expiry the child is SIGKILLed and the call rejects
  // with a TIMEOUT LogBookError.
  timeoutMs: number
  // Name used in error messages. Kept separate from `command` because the
  // binary may be an absolute path while the message should read as the tool name.
  label: string
  // Optional external cancellation. When it aborts, the child is SIGKILLed and
  // the call rejects with an ABORTED LogBookError.
  signal?: AbortSignal
  // When set and the spawn fails with ENOENT, this hint is appended to a
  // "not installed or not on PATH" message instead of the generic spawn error.
  notFoundHint?: string
  // Replaces the child's environment entirely (spawn semantics); omit to inherit.
  env?: NodeJS.ProcessEnv
  // Working directory of the child; omit to inherit.
  cwd?: string
  // Written to the child's stdin, which is then closed; omit to give it none.
  // Keeps a large or private payload (a model prompt) out of the argument
  // vector, which any process listing shows.
  input?: string
}

export interface ISubprocessResult {
  stdout: string
  stderr: string
  exitCode: number
}

// Run a child process to completion: capture stdout and stderr, enforce a
// wall-clock timeout, honour an optional AbortSignal, and map spawn, timeout and
// abort failures to a typed LogBookError. A non-zero exit code is a result, not
// an error; a child ended by a signal reports -1.
export const runSubprocess = ({
  command,
  args,
  timeoutMs,
  label,
  signal,
  notFoundHint,
  env,
  cwd,
  input,
}: IRunSubprocessOptions): Promise<ISubprocessResult> => {
  if (signal?.aborted) {
    return Promise.reject(new LogBookError(`${label} was aborted before it started.`, ERROR_CODES.ABORTED))
  }

  // Stdin is closed at once, after `input` when there is one, so a child that
  // reads it sees the end of input either way.
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(env === undefined ? {} : { env }),
    ...(cwd === undefined ? {} : { cwd }),
  })
  // A child that exits before reading all of it closes the pipe; its exit code
  // and output report that, so the write error itself is dropped.
  child.stdin.on('error', () => undefined)
  child.stdin.end(input ?? '')

  return new Promise<ISubprocessResult>((resolvePromise, rejectPromise) => {
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    let hasSettled = false

    // Every terminal path runs the same teardown (stop the timer, detach the
    // abort listener) so nothing fires after the process has settled. Registered
    // as a list to keep declaration order clean: each cleanup closes over a
    // binding already defined above it.
    const cleanups: (() => void)[] = []
    const settle = (): void => {
      hasSettled = true
      for (const cleanup of cleanups) {
        cleanup()
      }
    }

    const abortHandler = (): void => {
      if (hasSettled) {
        return
      }
      settle()
      child.kill('SIGKILL')
      rejectPromise(new LogBookError(`${label} was aborted.`, ERROR_CODES.ABORTED))
    }

    const timer = setTimeout(() => {
      if (hasSettled) {
        return
      }
      settle()
      child.kill('SIGKILL')
      rejectPromise(new LogBookError(`${label} timed out after ${timeoutMs / 1000}s.`, ERROR_CODES.TIMEOUT))
    }, timeoutMs)
    cleanups.push(() => clearTimeout(timer))

    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true })
      cleanups.push(() => signal.removeEventListener('abort', abortHandler))
    }

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk.toString('utf-8')))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf-8')))

    child.on('error', (error) => {
      if (hasSettled) {
        return
      }
      settle()
      if (error.message.includes('ENOENT') && notFoundHint) {
        rejectPromise(
          new LogBookError(
            `${label} is not installed or not on PATH. ${notFoundHint}`,
            ERROR_CODES.INTERNAL_ERROR,
            error
          )
        )
        return
      }
      rejectPromise(new LogBookError(`Failed to spawn ${label}: ${error.message}`, ERROR_CODES.INTERNAL_ERROR, error))
    })

    child.on('close', (code) => {
      if (hasSettled) {
        return
      }
      settle()
      resolvePromise({ stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), exitCode: code ?? -1 })
    })
  })
}
