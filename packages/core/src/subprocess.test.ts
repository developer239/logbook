import * as childProcess from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isErrnoCode, LogBookError } from './errors.js'
import { runSubprocess } from './subprocess.js'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const NODE = process.execPath
const TIMEOUT_MS = 4000
const SHORT_TIMEOUT_MS = 1000
const MISSING_BINARY = 'log-book-missing-binary-for-test'
const SPAWN_ENOENT: unknown = expect.objectContaining({ code: 'ENOENT', syscall: `spawn ${MISSING_BINARY}` })

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ESRCH')) {
      return false
    }
    throw error
  }
}

// A child that records its pid in a file and then stays alive until killed.
const lingeringChild = (pidFile: string): string[] => [
  '-e',
  `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
]

const readPid = async (pidFile: string): Promise<number> => Number(await readFile(pidFile, 'utf8'))

describe('runSubprocess', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-subprocess-')))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('returns stdout, stderr and a non-zero exit code without rejecting', async () => {
    // Arrange
    const script = "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"

    // Act
    const result = await runSubprocess({ command: NODE, args: ['-e', script], timeoutMs: TIMEOUT_MS, label: 'node' })

    // Assert
    expect(result).toStrictEqual({ stdout: 'out', stderr: 'err', exitCode: 3 })
  })

  it('writes input to the child and closes stdin when there is none', async () => {
    // Arrange
    const echoStdin =
      "let data = ''; process.stdin.on('data', (chunk) => { data += chunk }).on('end', () => process.stdout.write('[' + data + ']'))"

    // Act
    const withInput = await runSubprocess({
      command: NODE,
      args: ['-e', echoStdin],
      timeoutMs: TIMEOUT_MS,
      label: 'node',
      input: 'prompt text',
    })
    const withoutInput = await runSubprocess({
      command: NODE,
      args: ['-e', echoStdin],
      timeoutMs: TIMEOUT_MS,
      label: 'node',
    })

    // Assert
    expect([withInput.stdout, withoutInput.stdout]).toStrictEqual(['[prompt text]', '[]'])
  })

  it('resolves when the child exits without reading a large input', async () => {
    // Arrange
    const input = 'x'.repeat(8 * 1024 * 1024)

    // Act
    const result = await runSubprocess({
      command: NODE,
      args: ['-e', 'process.exit(0)'],
      timeoutMs: TIMEOUT_MS,
      label: 'node',
      input,
    })

    // Assert
    expect(result).toStrictEqual({ stdout: '', stderr: '', exitCode: 0 })
  })

  it('rejects with TIMEOUT and kills a child that outlives the timeout', async () => {
    // Arrange
    const pidFile = join(directory, 'child.pid')

    // Act
    const running = runSubprocess({
      command: NODE,
      args: lingeringChild(pidFile),
      timeoutMs: SHORT_TIMEOUT_MS,
      label: 'node',
    })

    // Assert
    await expect(running).rejects.toStrictEqual(new LogBookError('node timed out after 1s.', 'TIMEOUT'))
    const pid = await readPid(pidFile)
    await vi.waitFor(() => expect(isRunning(pid)).toBe(false), { timeout: TIMEOUT_MS })
  })

  it('rejects with ABORTED and starts nothing when the signal is already aborted', async () => {
    // Arrange
    const controller = new AbortController()
    controller.abort()

    // Act
    const running = runSubprocess({
      command: NODE,
      args: ['-e', ''],
      timeoutMs: TIMEOUT_MS,
      label: 'node',
      signal: controller.signal,
    })

    // Assert
    await expect(running).rejects.toStrictEqual(new LogBookError('node was aborted before it started.', 'ABORTED'))
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })

  it('rejects with ABORTED and kills the child when aborted during the run', async () => {
    // Arrange
    const pidFile = join(directory, 'child.pid')
    const controller = new AbortController()
    const running = runSubprocess({
      command: NODE,
      args: lingeringChild(pidFile),
      timeoutMs: TIMEOUT_MS,
      label: 'node',
      signal: controller.signal,
    })
    const pid = await vi.waitFor(() => readPid(pidFile), { timeout: TIMEOUT_MS })

    // Act
    controller.abort()

    // Assert
    await expect(running).rejects.toStrictEqual(new LogBookError('node was aborted.', 'ABORTED'))
    await vi.waitFor(() => expect(isRunning(pid)).toBe(false), { timeout: TIMEOUT_MS })
  })

  it('rejects a missing binary with the hint when one is given', async () => {
    // Arrange
    const options = { command: MISSING_BINARY, args: [], timeoutMs: TIMEOUT_MS, label: 'claude' }

    // Act
    const withHint = runSubprocess({ ...options, notFoundHint: 'Install Claude Code.' })
    const withoutHint = runSubprocess(options)

    // Assert
    await expect(withHint).rejects.toStrictEqual(
      new LogBookError('claude is not installed or not on PATH. Install Claude Code.', 'INTERNAL_ERROR', SPAWN_ENOENT)
    )
    await expect(withoutHint).rejects.toStrictEqual(
      new LogBookError(`Failed to spawn claude: spawn ${MISSING_BINARY} ENOENT`, 'INTERNAL_ERROR', SPAWN_ENOENT)
    )
  })

  it('replaces the environment with env and runs in cwd', async () => {
    // Arrange
    vi.stubEnv('LOG_BOOK_PARENT_ONLY', 'parent')
    const script =
      'process.stdout.write(JSON.stringify([process.env.LOG_BOOK_PARENT_ONLY ?? null, process.env.LOG_BOOK_CHILD_ONLY, process.cwd()]))'

    // Act
    const result = await runSubprocess({
      command: NODE,
      args: ['-e', script],
      timeoutMs: TIMEOUT_MS,
      label: 'node',
      env: { LOG_BOOK_CHILD_ONLY: 'child' },
      cwd: directory,
    })

    // Assert
    expect(JSON.parse(result.stdout)).toStrictEqual([null, 'child', directory])
  })
})
