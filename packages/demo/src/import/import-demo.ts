import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { LogBookError } from '@log-book/core'
import { WarehouseStore, type IImportedSession, type IWarehouseReader } from '@log-book/warehouse'
import { DEMO_ERROR_CODES } from '../errors.js'
import { demoWarehousePath, sealedEnvironment } from '../sealed-environment.js'
import type { IWrittenDemo } from '../write/write-demo.js'

const run = promisify(execFile)

// This module's own location, which the network allowlist test reads, so moving the file without its entry fails.
export const IMPORT_DEMO_URL = import.meta.url

// The CLI as users get it: the bundle `pnpm build` stages.
const BUILT_CLI = fileURLToPath(new URL('../../../../apps/cli/package/dist/cli.mjs', import.meta.url))

// Doctor's lines start with a label padded to this width; an adapter's answer follows it.
const DOCTOR_COLUMN = 12
const FOUND = /^found at ~\/(?<path>\S+)$/u
const MAX_BUFFER = 64 * 1024 * 1024

interface ICliRun {
  code: number
  stdout: string
  stderr: string
}

const isRunFailure = (error: unknown): error is { code: number; stdout: string; stderr: string } =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number'

// One logbook command with exactly the sealed environment, nothing of this process's.
const runCli = async (cli: string, out: string, args: readonly string[]): Promise<ICliRun> => {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      env: sealedEnvironment(out),
      maxBuffer: MAX_BUFFER,
    })
    return { code: 0, stdout, stderr }
  } catch (error: unknown) {
    if (isRunFailure(error)) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr }
    }
    throw error
  }
}

const lastLine = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .findLast((line) => line !== '') ?? ''

// The adapters' lines of `logbook doctor`: those between the warehouse line and the labelling line.
const adapterLines = (stdout: string): string[] => {
  const lines = stdout.split('\n')
  const end = lines.findIndex((line) => line.startsWith('Labelling '))
  return lines.slice(2, end === -1 ? lines.length : end)
}

// Every adapter found the place the writers wrote, under the home, with nothing after the path: anything else means the
// import would not read exactly what was written.
const preflight = async (cli: string, out: string, homeFiles: readonly string[]): Promise<void> => {
  const doctor = await runCli(cli, out, ['doctor'])
  if (doctor.code !== 0) {
    throw new LogBookError(
      `logbook doctor exited ${String(doctor.code)}: ${lastLine(doctor.stderr)}`,
      DEMO_ERROR_CODES.DEMO_PREFLIGHT_FAILED
    )
  }
  for (const line of adapterLines(doctor.stdout)) {
    const path = FOUND.exec(line.slice(DOCTOR_COLUMN))?.groups?.path
    const isWritten = path !== undefined && homeFiles.some((file) => file === path || file.startsWith(`${path}/`))
    if (!isWritten) {
      throw new LogBookError(
        `The preflight wants every adapter found at a place the writers wrote; doctor says: ${line.trim()}`,
        DEMO_ERROR_CODES.DEMO_PREFLIGHT_FAILED
      )
    }
  }
}

// A record field as its column: snake_case, with a boolean stored as 0 or 1.
const columnOf = (field: string): string => field.replaceAll(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)

const stored = (value: unknown): unknown => {
  if (typeof value === 'boolean') {
    return value ? 1 : 0
  }
  return value
}

interface IRecordKind {
  name: string
  table: string
  // The records of this kind in one imported session.
  records: (session: IImportedSession) => readonly object[]
  // A record's id as the error names it, from the record or from its row.
  id: (fields: Readonly<Record<string, unknown>>) => string
  // Fields the sync derives after the import, which the comparison leaves out.
  derived: ReadonlySet<string>
}

const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')

const RECORD_KINDS: readonly IRecordKind[] = [
  {
    name: 'session',
    table: 'session',
    records: (imported) => [imported.session],
    id: (fields) => text(fields.id),
    // The link pass sets the origin from the session's links and isScripted.
    derived: new Set(['origin']),
  },
  {
    name: 'message',
    table: 'message',
    records: (imported) => imported.messages,
    id: (fields) => text(fields.id),
    derived: new Set(),
  },
  {
    name: 'part',
    table: 'part',
    records: (imported) => imported.parts,
    id: (fields) => `${text(fields.messageId ?? fields.message_id)}#${text(fields.idx)}`,
    derived: new Set(),
  },
  {
    name: 'tool call',
    table: 'tool_call',
    records: (imported) => imported.toolCalls,
    id: (fields) => text(fields.id),
    derived: new Set(),
  },
  {
    name: 'event',
    table: 'event',
    records: (imported) => imported.events,
    id: (fields) => text(fields.id),
    derived: new Set(),
  },
]

const mismatch = (message: string): LogBookError => new LogBookError(message, DEMO_ERROR_CODES.DEMO_IMPORT_MISMATCH)

// The records of one kind against the table: the same ids, and every field of each equal to its column. An error
// names the record and the field, never a value.
const compareKind = (reader: IWarehouseReader, kind: IRecordKind, expected: readonly IImportedSession[]): void => {
  const rows = new Map(
    reader.all<Record<string, unknown>>(`SELECT * FROM ${kind.table}`).map((row) => [kind.id(row), row])
  )
  const records = expected.flatMap((imported) => kind.records(imported)) as Readonly<Record<string, unknown>>[]
  for (const record of records) {
    const id = kind.id(record)
    const row = rows.get(id)
    if (row === undefined) {
      throw mismatch(`The ${kind.name} ${id} is missing from the warehouse.`)
    }
    rows.delete(id)
    const field = Object.keys(record).find(
      (name) => !kind.derived.has(name) && stored(record[name]) !== row[columnOf(name)]
    )
    if (field !== undefined) {
      throw mismatch(`The ${kind.name} ${id} differs from the expected record in its field ${field}.`)
    }
  }
  const [unexpected] = rows.keys()
  if (unexpected !== undefined) {
    throw mismatch(`The ${kind.name} ${unexpected} is in the warehouse but not among the expected records.`)
  }
}

const compare = async (warehousePath: string, expected: readonly IImportedSession[]): Promise<void> => {
  const reader = await WarehouseStore.openReadOnly(warehousePath)
  try {
    for (const kind of RECORD_KINDS) {
      compareKind(reader, kind, expected)
    }
  } finally {
    reader.close()
  }
}

export interface IImportDemoOptions {
  // The CLI's built entry; the staged bundle unless a test names another.
  cli?: string
}

// Imports `<out>/home` as a user's data is imported: the built logbook, in a child process whose environment is the
// sealed one, first `doctor` as the preflight, then `sync`, then every imported record read back and compared with
// the writers' expected records.
export const importDemo = async (
  out: string,
  written: Pick<IWrittenDemo, 'expected' | 'homeFiles'>,
  { cli = BUILT_CLI }: IImportDemoOptions = {}
): Promise<void> => {
  if (!existsSync(cli)) {
    throw new LogBookError('the built CLI is missing; run pnpm build', DEMO_ERROR_CODES.DEMO_CLI_MISSING)
  }
  await preflight(cli, out, written.homeFiles)
  const sync = await runCli(cli, out, ['sync'])
  if (sync.code !== 0) {
    throw new LogBookError(
      `logbook sync exited ${String(sync.code)}: ${lastLine(sync.stderr)}`,
      DEMO_ERROR_CODES.DEMO_SYNC_FAILED
    )
  }
  await compare(demoWarehousePath(out), written.expected)
}
