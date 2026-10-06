import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'

// A stand-in for the logbook entry: it appends its arguments to a file, writes the stderr lines and exits with the code
// the test chose, both read from its environment, which it inherits from the web process.
const STUB = `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.LOGBOOK_STUB_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n')
for (const line of JSON.parse(process.env.LOGBOOK_STUB_STDERR ?? '[]')) {
  process.stderr.write(line + '\\n')
}
process.exitCode = Number(process.env.LOGBOOK_STUB_EXIT ?? '0')
`

export interface ILogbookStub {
  path: string
  // What the next run does.
  answer: (code: number, stderr?: readonly string[]) => void
  // The arguments of every run so far.
  calls: () => Promise<string[][]>
}

// Writes the stub into `directory` and points LOGBOOK_CLI at it.
export const logbookStub = async (directory: string): Promise<ILogbookStub> => {
  const path = join(directory, 'logbook-stub.mjs')
  const calls = join(directory, 'calls.ndjson')
  await writeFile(path, STUB)
  await writeFile(calls, '')
  vi.stubEnv('LOGBOOK_CLI', path)
  vi.stubEnv('LOGBOOK_STUB_CALLS', calls)
  const stub: ILogbookStub = {
    path,
    answer: (code, stderr = []) => {
      vi.stubEnv('LOGBOOK_STUB_EXIT', String(code))
      vi.stubEnv('LOGBOOK_STUB_STDERR', JSON.stringify(stderr))
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
