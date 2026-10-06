import { existsSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'

// A stand-in for the logbook entry: it appends its arguments to a file, writes the stdout and stderr the test chose and
// exits with its code, all read from its environment, which it inherits from the web process.
// - A holding stub writes its pid to a file and exits only once the test releases it.
// - A waiting stub writes its pid, takes the labelling lock when asked, and runs until SIGTERM, which it marks and
//   exits `interrupted` on, as a labelling run does; when asked, only once the test releases it.
const STUB = `import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
const pidFile = process.env.LOGBOOK_STUB_PID
const released = () =>
  new Promise((resolve) => {
    const timer = setInterval(() => {
      if (existsSync(pidFile + '.release')) {
        clearInterval(timer)
        resolve()
      }
    }, 20)
  })
appendFileSync(process.env.LOGBOOK_STUB_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdout.write(process.env.LOGBOOK_STUB_STDOUT ?? '')
for (const line of JSON.parse(process.env.LOGBOOK_STUB_STDERR ?? '[]')) {
  process.stderr.write(line + '\\n')
}
process.exitCode = Number(process.env.LOGBOOK_STUB_EXIT ?? '0')
if (process.env.LOGBOOK_STUB_WAITS === '1') {
  if (process.env.LOGBOOK_STUB_LOCKS === '1') {
    writeFileSync(
      process.env.LOGBOOK_DB + '.labels.lock',
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), operation: 'labels' })
    )
  }
  process.on('SIGTERM', async () => {
    writeFileSync(pidFile + '.sigterm', '')
    if (process.env.LOGBOOK_STUB_HOLDS_STOP === '1') {
      await released()
    }
    process.exit(130)
  })
  writeFileSync(pidFile, String(process.pid))
  setInterval(() => {}, 60000)
} else if (process.env.LOGBOOK_STUB_HOLDS === '1') {
  writeFileSync(pidFile, String(process.pid))
  await released()
}
`

interface IStubAnswer {
  stdout?: string
  // Write the pid and exit only once released.
  isHolding?: boolean
  // Write the pid and run until SIGTERM.
  isWaiting?: boolean
  // While waiting, hold the labelling lock of the warehouse LOGBOOK_DB names.
  isLocking?: boolean
  // On SIGTERM, exit only once released.
  isHoldingStop?: boolean
}

export interface ILogbookStub {
  path: string
  // What the next run does.
  answer: (code: number, stderr?: readonly string[], options?: IStubAnswer) => void
  // The pid the last holding or waiting stub wrote, once it has.
  pid: () => Promise<number>
  // Lets a holding stub, or a waiting one that holds its stop, exit.
  release: () => Promise<void>
  // Whether the last waiting stub received SIGTERM.
  isSignalled: () => boolean
  // The arguments of every run so far.
  calls: () => Promise<string[][]>
}

// How long a stub may take to start and write its pid: over a second on the slowest runner (Intel macOS), well inside
// the web project's test timeout.
export const STUB_START_TIMEOUT_MS = 5000

// Writes the stub into `directory` and points LOGBOOK_CLI at it.
export const logbookStub = async (directory: string): Promise<ILogbookStub> => {
  const path = join(directory, 'logbook-stub.mjs')
  const calls = join(directory, 'calls.ndjson')
  const pidFile = join(directory, 'stub.pid')
  await writeFile(path, STUB)
  await writeFile(calls, '')
  vi.stubEnv('LOGBOOK_CLI', path)
  vi.stubEnv('LOGBOOK_STUB_CALLS', calls)
  vi.stubEnv('LOGBOOK_STUB_PID', pidFile)
  const stub: ILogbookStub = {
    path,
    answer: (
      code,
      stderr = [],
      { stdout = '', isHolding = false, isWaiting = false, isLocking = false, isHoldingStop = false } = {}
    ) => {
      vi.stubEnv('LOGBOOK_STUB_EXIT', String(code))
      vi.stubEnv('LOGBOOK_STUB_STDERR', JSON.stringify(stderr))
      vi.stubEnv('LOGBOOK_STUB_STDOUT', stdout)
      vi.stubEnv('LOGBOOK_STUB_HOLDS', isHolding ? '1' : '0')
      vi.stubEnv('LOGBOOK_STUB_WAITS', isWaiting ? '1' : '0')
      vi.stubEnv('LOGBOOK_STUB_LOCKS', isLocking ? '1' : '0')
      vi.stubEnv('LOGBOOK_STUB_HOLDS_STOP', isHoldingStop ? '1' : '0')
      for (const file of [pidFile, `${pidFile}.release`, `${pidFile}.sigterm`]) {
        rmSync(file, { force: true })
      }
    },
    pid: async () => {
      await vi.waitFor(
        () => {
          if (!existsSync(pidFile)) {
            throw new Error('The stub has not written its pid yet')
          }
        },
        { timeout: STUB_START_TIMEOUT_MS }
      )
      return Number(await readFile(pidFile, 'utf8'))
    },
    release: async () => {
      await writeFile(`${pidFile}.release`, '')
    },
    isSignalled: () => existsSync(`${pidFile}.sigterm`),
    calls: async () =>
      (await readFile(calls, 'utf8'))
        .split('\n')
        .filter((text) => text !== '')
        .map((text) => JSON.parse(text) as string[]),
  }
  stub.answer(0)
  return stub
}
