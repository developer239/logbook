import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { isErrnoCode, openSqlite } from '@log-book/core'
import type { IImportedSession } from '@log-book/warehouse'
import type { IAdapterEnvironment, IHarnessAdapter, IHarnessLocation, IPrompt } from '../contract.js'
import {
  projectDirIn,
  SOURCE_WRITER_ERROR_CODES,
  type ICommandFile,
  type ISessionScript,
  type ISourceWriter,
  type IWrittenSource,
  type ScriptStep,
} from '../source-writer/index.js'
import { validateImportedUnit } from '../validate.js'
import type { IConformanceCase } from './fixture-set.js'
import { goldenText } from './golden.js'
import { hashFile, hashTree, withEmptyHome } from './home.js'
import {
  expectedAnswer,
  firstKnownTool,
  knownToolScripts,
  projectCommandFile,
  projectCommandScripts,
  refusalsFor,
  SHIP_CHECK,
} from './round-trip-scripts.js'
import { importEvery, locateFound, withReader, type IListedImport } from './session.js'

const SQLITE_HEADER = 'SQLite format 3\u0000'

interface IRoundTrip {
  readonly adapter: IHarnessAdapter
  readonly writer: ISourceWriter
  readonly scripts: readonly ISessionScript[]
  readonly commandFiles: readonly ICommandFile[]
}

interface IWrittenHome {
  commandFiles: readonly string[]
  written: IWrittenSource
  env: IAdapterEnvironment
}

type TRoundTripRun = (trip: IRoundTrip) => Promise<void>

const environmentOf = (home: string): IAdapterEnvironment => ({
  variables: {},
  homeDir: home,
  cwd: home,
  platform: process.platform === 'darwin' ? 'darwin' : 'linux',
})

const writeHome = async (
  writer: ISourceWriter,
  home: string,
  scripts: readonly ISessionScript[],
  commandFiles: readonly ICommandFile[]
): Promise<IWrittenHome> => ({
  commandFiles: await writer.writeCommandFiles(home, commandFiles),
  written: await writer.writeSessions(home, scripts),
  env: environmentOf(home),
})

const sortedText = (sessions: readonly IImportedSession[], home: string): string =>
  goldenText(
    {
      sessions: [...sessions].toSorted((left, right) => (left.session.id < right.session.id ? -1 : 1)),
      harnessVersion: null,
    },
    home
  )

// Every script with the scripts its spawns started, depth first.
const allScripts = (scripts: readonly ISessionScript[]): ISessionScript[] =>
  scripts.flatMap((script) => [
    script,
    ...allScripts(script.steps.flatMap((step) => (step.kind === 'spawn' ? [step.child] : []))),
  ])

const importWritten = async (
  adapter: IHarnessAdapter,
  env: IAdapterEnvironment
): Promise<{ location: IHarnessLocation; imports: IListedImport[] }> => {
  const location = await locateFound(adapter, env)
  return { location, imports: await withReader(adapter, location, importEvery) }
}

const roundTripCase: TRoundTripRun = async ({ adapter, writer, scripts, commandFiles }) =>
  withEmptyHome(async (home) => {
    const { commandFiles: commandPaths, written, env } = await writeHome(writer, home, scripts, commandFiles)
    const before = await hashTree(home)
    const files = Object.keys(before).filter((path) => before[path] !== 'not a file')
    const { imports } = await importWritten(adapter, env)
    const imported = imports.flatMap(({ imported: unit }) => unit.sessions)
    assert.deepEqual(
      {
        files: files.toSorted(),
        sessions: sortedText(imported, home),
        problems: imports.flatMap(({ imported: unit }) => validateImportedUnit(adapter.descriptor, unit)),
      },
      {
        files: [...commandPaths, ...written.files].toSorted(),
        sessions: sortedText(written.expected, home),
        problems: [],
      }
    )
    assert.deepEqual(await hashTree(home), before, 'importing changed or added a file')
  })

// The prompt a command step became, as importUnit returned it.
const commandPrompt = (
  imported: readonly IImportedSession[],
  messageId: string | undefined,
  projectDir: string
): IPrompt | null => {
  const session = imported.find((candidate) => candidate.messages.some((message) => message.id === messageId))
  const message = session?.messages.find((candidate) => candidate.id === messageId)
  const part = session?.parts
    .filter((candidate) => candidate.messageId === messageId && candidate.kind === 'text')
    .toSorted((left, right) => left.idx - right.idx)[0]
  if (message === undefined || part === undefined || (message.actor !== 'user' && message.actor !== 'harness')) {
    return null
  }
  return { actor: message.actor, text: part.text, projectDir }
}

const commandSteps = (
  scripts: readonly ISessionScript[]
): { step: Extract<ScriptStep, { kind: 'command' }>; script: ISessionScript }[] =>
  allScripts(scripts).flatMap((script) =>
    script.steps.flatMap((step) => (step.kind === 'command' ? [{ step, script }] : []))
  )

const assertCommandAnswers = async (
  trip: IRoundTrip,
  home: string,
  scripts: readonly ISessionScript[],
  commandFiles: readonly ICommandFile[],
  written: IWrittenHome
): Promise<void> => {
  const { location, imports } = await importWritten(trip.adapter, written.env)
  const imported = imports.flatMap(({ imported: unit }) => unit.sessions)
  const projectDirs = [...new Set(allScripts(scripts).map((script) => projectDirIn(home, script.projectDir)))]
  const recogniser = await trip.adapter.prepareCommands(location, written.env, projectDirs)
  const steps = commandSteps(scripts)
  assert.deepEqual(
    steps.map(({ step, script }) => {
      const prompt = commandPrompt(imported, written.written.ids.get(step.key), projectDirIn(home, script.projectDir))
      return { key: step.key, answer: prompt === null ? 'no prompt' : recogniser.recognise(prompt) }
    }),
    steps.map(({ step, script }) => ({
      key: step.key,
      answer: expectedAnswer(trip.writer, step.name, script.projectDir, commandFiles),
    }))
  )
}

const commandsCase: TRoundTripRun = async (trip) =>
  withEmptyHome(async (home) => {
    const written = await writeHome(trip.writer, home, trip.scripts, trip.commandFiles)
    await assertCommandAnswers(trip, home, trip.scripts, trip.commandFiles, written)
  })

// What a file holds: a SQLite database's rows, any other file's bytes.
const contentOf = async (path: string): Promise<string> => {
  const bytes = await readFile(path)
  if (bytes.subarray(0, SQLITE_HEADER.length).toString('latin1') !== SQLITE_HEADER) {
    return hashFile(path)
  }
  const db = await openSqlite(path, { isReadOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string
    }[]
    return JSON.stringify(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
  } finally {
    db.close()
  }
}

const homeContents = async (home: string, files: readonly string[]): Promise<Record<string, string>> =>
  Object.fromEntries(
    await Promise.all(files.map(async (file): Promise<[string, string]> => [file, await contentOf(join(home, file))]))
  )

const writtenState = async (trip: IRoundTrip, home: string): Promise<unknown> => {
  const { written, commandFiles, env } = await writeHome(trip.writer, home, trip.scripts, trip.commandFiles)
  const location = await locateFound(trip.adapter, env)
  const units = await withReader(trip.adapter, location, async (reader) => reader.listUnits())
  return {
    expected: goldenText({ sessions: [...written.expected], harnessVersion: null }, home),
    ids: [...written.ids.entries()],
    files: written.files,
    commandFiles,
    contents: await homeContents(home, [...commandFiles, ...written.files]),
    units,
  }
}

const deterministicCase: TRoundTripRun = async (trip) => {
  const first = await withEmptyHome(async (home) => writtenState(trip, home))
  const second = await withEmptyHome(async (home) => writtenState(trip, home))
  assert.deepEqual(second, first)
}

// Whether the writer refused the script as unsupported, naming the key, with the home still empty.
interface IRefusalOutcome {
  isUnsupported: boolean
  isNamed: boolean
  home: string[]
}

const refusalOutcome = async (writer: ISourceWriter, script: ISessionScript, key: string): Promise<IRefusalOutcome> =>
  withEmptyHome(async (home) => {
    const failure: unknown = await writer.writeSessions(home, [script]).then(
      () => null,
      (error: unknown) => error
    )
    return {
      isUnsupported: isErrnoCode(failure, SOURCE_WRITER_ERROR_CODES.WRITER_SCRIPT_UNSUPPORTED),
      isNamed: failure instanceof Error && failure.message.includes(key),
      home: await readdir(home),
    }
  })

const refusalsCase: TRoundTripRun = async ({ writer }) => {
  const refusals = refusalsFor(writer)
  const outcomes = await Promise.all(
    refusals.map(async ({ lacks, script, key }) => ({ lacks, ...(await refusalOutcome(writer, script, key)) }))
  )
  assert.deepEqual(
    outcomes,
    refusals.map(({ lacks }) => ({ lacks, isUnsupported: true, isNamed: true, home: [] }))
  )
}

const knownToolsCase: TRoundTripRun = async (trip) =>
  withEmptyHome(async (home) => {
    const scripts = knownToolScripts(trip.writer)
    const { written, env } = await writeHome(trip.writer, home, scripts, [])
    const { imports } = await importWritten(trip.adapter, env)
    const calls = imports.flatMap(({ imported: unit }) => unit.sessions.flatMap((session) => session.toolCalls))
    const steps = scripts.flatMap((script) => script.steps.flatMap((step) => (step.kind === 'call' ? [step] : [])))
    assert.deepEqual(
      steps.map((step) => {
        const call = calls.find((candidate) => candidate.id === written.ids.get(step.key))
        return { key: step.key, bareName: call?.bareName, family: call?.family, server: call?.server }
      }),
      steps.map((step) => ({
        key: step.key,
        bareName: firstKnownTool(step.family),
        family: step.family,
        server: step.server,
      }))
    )
  })

const projectCommandCase: TRoundTripRun = async (trip) =>
  withEmptyHome(async (home) => {
    const scripts = projectCommandScripts(trip.writer)
    const written = await writeHome(trip.writer, home, scripts, [projectCommandFile])
    const shopDir = relative(home, projectDirIn(home, projectCommandFile.projectDir ?? ''))
    assert.deepEqual(
      written.commandFiles.map((file) => file.startsWith(`${shopDir}/`)),
      [true],
      `the ${SHIP_CHECK} command file is not the one file below ${shopDir}: ${JSON.stringify(written.commandFiles)}`
    )
    await assertCommandAnswers(trip, home, scripts, [projectCommandFile], written)
  })

const hasCommands = (writer: ISourceWriter): boolean =>
  writer.capabilities.has('typed-command') || writer.capabilities.has('template-command')

// The cases that prove a writer and its adapter agree: what the writer writes imports back as exactly the records it
// said, and a script it cannot record is refused, never written differently. Each case writes into a fresh empty home
// and deletes it afterwards.
export const roundTripCases = (
  adapter: IHarnessAdapter,
  writer: ISourceWriter,
  scripts: readonly ISessionScript[],
  commandFiles: readonly ICommandFile[]
): readonly IConformanceCase[] => {
  const trip: IRoundTrip = { adapter, writer, scripts, commandFiles }
  const cases: [string, TRoundTripRun][] = [
    ['R1 round trip', roundTripCase],
    ['R2 commands', commandsCase],
    ['R3 deterministic', deterministicCase],
    ['R4 refusals', refusalsCase],
    ['R5 known tools', knownToolsCase],
    ...(hasCommands(writer) ? [['R6 project command', projectCommandCase] as [string, TRoundTripRun]] : []),
  ]
  return cases.map(([name, run]) => ({ name, run: async () => run(trip) }))
}
