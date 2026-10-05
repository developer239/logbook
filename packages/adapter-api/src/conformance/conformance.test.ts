import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isErrnoCode, LogBookError } from '@log-book/core'
import type { IEventRecord, IImportedSession, IMessageRecord, IPartRecord } from '@log-book/warehouse'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IHarnessAdapter, IHarnessLocation, IImportedUnit, IPrompt, ISourceUnit } from '../contract.js'
import { ADAPTER_ERROR_CODES, childIdOf, sessionIdOf, timeSpan, unknownEvent } from '../helpers.js'
import { conformanceCases, type IFixtureSet } from './index.js'

// A minimal correct adapter for an invented harness that keeps one JSON-lines log per session.
const MINIMAL_ID = 'minimal-harness'
const LOG_SUFFIX = '.jsonl'
const LATER_THAN_ANY_FIXTURE = new Date('2030-01-01T00:00:00Z')
const FIXTURE_ROOT = fileURLToPath(new URL('fixtures/1.0', import.meta.url))

interface IMetaLine {
  type: 'meta'
  version: string
  project: string
}

interface IMessageLine {
  type: 'message'
  id: string
  role: 'user' | 'assistant'
  text: string
  at: number
}

// A record of a kind the adapter does not know.
interface IOtherLine {
  type: string
  at: number
}

type TMinimalRecord = IMetaLine | IMessageLine | IOtherLine

interface IParsedLog {
  version: string | null
  project: string | null
  messages: IMessageRecord[]
  parts: IPartRecord[]
  events: IEventRecord[]
}

const sessionsDirectory = (home: string): string => join(home, '.minimal', 'sessions')

const readLog = async (path: string): Promise<string> => {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      throw new LogBookError(`The log ${path} is gone.`, ADAPTER_ERROR_CODES.ADAPTER_UNIT_GONE, error)
    }
    throw error
  }
}

const isMeta = (record: TMinimalRecord): record is IMetaLine => record.type === 'meta'

const isMessage = (record: TMinimalRecord): record is IMessageLine => record.type === 'message'

const addRecord = (parsed: IParsedLog, sessionId: string, record: TMinimalRecord, line: number): void => {
  if (isMeta(record)) {
    parsed.version = record.version
    parsed.project = record.project
  } else if (isMessage(record)) {
    const id = childIdOf(sessionId, record.id)
    parsed.messages.push({
      id,
      sessionId,
      seq: parsed.messages.length,
      actor: record.role,
      sourceRole: record.role,
      createdAt: record.at,
      completedAt: null,
      requestedAt: null,
      model: null,
      agent: null,
      gitBranch: null,
      tokensInput: null,
      tokensOutput: null,
      tokensReasoning: null,
      tokensCacheRead: null,
      tokensCacheWrite: null,
      reportedCost: null,
    })
    parsed.parts.push({ messageId: id, sessionId, idx: 0, kind: 'text', text: record.text, toolCallId: null })
  } else {
    const description = { what: 'record', type: record.type, harnessVersion: parsed.version, raw: record } as const
    parsed.events.push(unknownEvent(sessionId, `line-${String(line)}`, record.at, description))
  }
}

const importLog = async (root: string, unit: ISourceUnit): Promise<IImportedUnit> => {
  const text = await readLog(join(root, unit.locator))
  const sourceId = basename(unit.locator, LOG_SUFFIX)
  const sessionId = sessionIdOf(MINIMAL_ID, sourceId)
  const parsed: IParsedLog = { version: null, project: null, messages: [], parts: [], events: [] }
  for (const [line, record] of text.split('\n').entries()) {
    if (record !== '') {
      addRecord(parsed, sessionId, JSON.parse(record) as TMinimalRecord, line + 1)
    }
  }
  const session: IImportedSession = {
    session: {
      id: sessionId,
      harness: MINIMAL_ID,
      sourceId,
      origin: 'interactive',
      isScripted: false,
      projectDir: parsed.project,
      title: null,
      agent: null,
      spawnedBySessionId: null,
      spawnedByToolCallId: null,
      ...timeSpan(parsed.messages),
    },
    messages: parsed.messages,
    parts: parsed.parts,
    toolCalls: [],
    events: parsed.events,
  }
  return { sessions: [session], harnessVersion: parsed.version }
}

const listLogs = async (root: string, signal: AbortSignal): Promise<ISourceUnit[]> => {
  const names = (await readdir(root)).filter((name) => name.endsWith(LOG_SUFFIX)).toSorted()
  return Promise.all(
    names.map(async (name) => {
      signal.throwIfAborted()
      const { size, mtimeMs } = await stat(join(root, name))
      return { locator: name, fingerprint: `${String(size)}:${String(mtimeMs)}` }
    })
  )
}

const recogniseTyped =
  (commands: ReadonlySet<string>) =>
  (prompt: IPrompt): { command: string; source: 'typed'; hasFile: boolean } | null => {
    const command = /^\/(?<name>[a-z-]+)/u.exec(prompt.text)?.groups?.name
    return prompt.actor === 'user' && command !== undefined && commands.has(command)
      ? { command, source: 'typed', hasFile: true }
      : null
  }

const minimalAdapter: IHarnessAdapter = {
  descriptor: {
    id: MINIMAL_ID,
    name: 'Minimal Harness',
    defaultAgent: 'main',
    unitNoun: 'logs',
    filterAlias: 'minimal',
    parserVersion: 1,
    testedVersions: ['1.0'],
    locationVariables: ['MINIMAL_SESSIONS_DIR'],
  },
  locate: async (env) => {
    const root = env.variables.MINIMAL_SESSIONS_DIR ?? sessionsDirectory(env.homeDir)
    const isDirectory = await stat(root).then(
      (found) => found.isDirectory(),
      () => false
    )
    const location: IHarnessLocation = { root, kind: 'directory', describe: root.replace(env.homeDir, '~') }
    return isDirectory ? { kind: 'found', location } : { kind: 'not-found', lookedAt: root }
  },
  openSource: async (location, context) =>
    Promise.resolve({
      formatDrift: null,
      listUnits: async () => listLogs(location.root, context.signal),
      importUnit: async (unit) => importLog(location.root, unit),
      close: async () => Promise.resolve(),
    }),
  prepareCommands: async (_location, env) => {
    const files = await readdir(join(env.homeDir, '.minimal', 'commands'))
    return { recognise: recogniseTyped(new Set(files.map((file) => basename(file, '.md')))) }
  },
}

const minimalFixture = (root: string): IFixtureSet => ({
  harnessVersion: '1.0',
  root,
  locationKind: 'directory',
  units: [
    {
      locator: 'alpha.jsonl',
      harnessVersion: '1.0.3',
      unknownRecords: [{ type: 'mystery', note: 'a record this harness version added', at: 2500 }],
    },
    // Recorded by a version newer than the tested one, and imported normally.
    { locator: 'beta.jsonl', harnessVersion: '1.2.0', unknownRecords: [] },
  ],
  environment: (home) => ({
    variables: { MINIMAL_SESSIONS_DIR: sessionsDirectory(home) },
    homeDir: home,
    cwd: home,
    platform: 'linux',
  }),
  prepare: async (home) => {
    await mkdir(join(home, 'work', 'shop'), { recursive: true })
  },
  change: async (home, locator) => {
    const path = join(sessionsDirectory(home), locator)
    await writeFile(path, '{"type":"message","id":"m9","role":"user","text":"one more thing","at":9000}\n', {
      flag: 'a',
    })
    await utimes(path, LATER_THAN_ANY_FIXTURE, LATER_THAN_ANY_FIXTURE)
  },
  remove: async (home, locator) => {
    await rm(join(sessionsDirectory(home), locator))
  },
})

const caseNamed = (fixture: IFixtureSet, name: string): (() => Promise<void>) => {
  const found = conformanceCases(minimalAdapter, [fixture]).find((candidate) => candidate.name === name)
  if (found === undefined) {
    throw new Error(`No conformance case is named ${name}`)
  }
  return found.run
}

describe('conformanceCases for a minimal correct adapter', () => {
  it.each(
    conformanceCases(minimalAdapter, [minimalFixture(FIXTURE_ROOT)]).map((testCase) => [testCase.name, testCase])
  )('%s', async (_name, testCase) => {
    // Act
    const run = testCase.run()

    // Assert
    await expect(run).resolves.toBeUndefined()
  })
})

describe('golden file regeneration', () => {
  let directory = ''

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  })

  it('rewrites a stale golden file, after which the golden output case passes', async () => {
    // Arrange
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-golden-')))
    await cp(FIXTURE_ROOT, directory, { recursive: true })
    const golden = join(directory, 'expected', 'alpha.jsonl.json')
    await writeFile(golden, '{ "stale": true }\n')
    const fixture = minimalFixture(directory)
    await expect(caseNamed(fixture, '1.0: golden output')()).rejects.toThrow()

    // Act
    vi.stubEnv('LOGBOOK_UPDATE_GOLDEN', '1')
    await caseNamed(fixture, '1.0: golden output')()
    vi.unstubAllEnvs()

    // Assert
    expect({
      golden: await readFile(golden, 'utf8'),
      check: await caseNamed(fixture, '1.0: golden output')().then(() => 'passes'),
    }).toStrictEqual({
      golden: await readFile(join(FIXTURE_ROOT, 'expected', 'alpha.jsonl.json'), 'utf8'),
      check: 'passes',
    })
  })
})
