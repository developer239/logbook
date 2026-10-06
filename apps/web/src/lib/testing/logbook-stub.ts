import { existsSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'

// A stand-in for the logbook entry: it appends its arguments to a file, writes the stdout and stderr the test chose and
// exits with its code, all read from its environment, which it inherits from the web process. A waiting stub writes its
// pid to a file and runs until a signal ends it, as a labelling run does.
const STUB = `import { appendFileSync, writeFileSync } from 'node:fs'
appendFileSync(process.env.LOGBOOK_STUB_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdout.write(process.env.LOGBOOK_STUB_STDOUT ?? '')
for (const line of JSON.parse(process.env.LOGBOOK_STUB_STDERR ?? '[]')) {
  process.stderr.write(line + '\\n')
}
process.exitCode = Number(process.env.LOGBOOK_STUB_EXIT ?? '0')
if (process.env.LOGBOOK_STUB_WAITS === '1') {
  writeFileSync(process.env.LOGBOOK_STUB_PID, String(process.pid))
  setInterval(() => {}, 60000)
}
`

interface IStubAnswer {
  stdout?: string
  // Write the pid and run until a signal ends it.
  isWaiting?: boolean
}

export interface ILogbookStub {
  path: string
  // What the next run does.
  answer: (code: number, stderr?: readonly string[], options?: IStubAnswer) => void
  // The pid the last waiting stub wrote, once it has.
  pid: () => Promise<number>
  // The arguments of every run so far.
  calls: () => Promise<string[][]>
}

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
    answer: (code, stderr = [], { stdout = '', isWaiting = false } = {}) => {
      vi.stubEnv('LOGBOOK_STUB_EXIT', String(code))
      vi.stubEnv('LOGBOOK_STUB_STDERR', JSON.stringify(stderr))
      vi.stubEnv('LOGBOOK_STUB_STDOUT', stdout)
      vi.stubEnv('LOGBOOK_STUB_WAITS', isWaiting ? '1' : '0')
      if (isWaiting) {
        rmSync(pidFile, { force: true })
      }
    },
    pid: async () => {
      await vi.waitFor(() => {
        if (!existsSync(pidFile)) {
          throw new Error('The waiting stub has not written its pid yet')
        }
      })
      return Number(await readFile(pidFile, 'utf8'))
    },
    calls: async () =>
      (await readFile(calls, 'utf8'))
        .split('\n')
        .filter((text) => text !== '')
        .map((text) => JSON.parse(text) as string[]),
  }
  stub.answer(0)
  return stub
}
