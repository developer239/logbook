import { access, mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { LogBookError } from '@log-book/core'
import type { IEventRecord, IImportedSession, IMessageRecord, IPartRecord, IToolCallRecord } from '@log-book/warehouse'
import { describe, expect, it } from 'vitest'
import type { IHarnessAdapter, IImportedUnit, IPrompt, IRecognisedCommand } from '../contract.js'
import { ADAPTER_ERROR_CODES, childIdOf, sessionIdOf, timeSpan } from '../helpers.js'
import { KNOWN_TOOLS } from '../known-tools.js'
import {
  checkCommandFiles,
  checkScripts,
  projectDirIn,
  SOURCE_WRITER_ERROR_CODES,
  type ICommandFile,
  type IScriptTokens,
  type ISessionScript,
  type ISourceWriter,
  type IWrittenSource,
  type ScriptFamily,
  type ScriptStep,
  type SourceCapability,
} from '../source-writer/index.js'
import { roundTripCases } from './index.js'

// A minimal writer and adapter pair for an invented harness that keeps one JSON-lines log per session.
const JOT_ID = 'jot'
const JOT_VERSION = '1.0.2'
// A dispatch call takes the first KNOWN_TOOLS name of its family, the only name a harness-neutral script can give it.
const TOOL_NAMES: Readonly<Partial<Record<ScriptFamily, string | undefined>>> = {
  shell: 'run_shell',
  read: 'read_file',
  dispatch: [...KNOWN_TOOLS].find(([, family]) => family === 'dispatch')?.[0],
}

type TLine =
  | { type: 'session'; id: string; cwd: string; title: string | null; version: string }
  | { type: 'user'; id: string; at: number; text: string }
  | {
      type: 'assistant'
      id: string
      at: number
      end: number
      model: string
      text: string | null
      thinking: string | null
      tokens: readonly (number | null)[]
    }
  | {
      type: 'tool'
      id: string
      in: string
      tool: string
      family: string
      input: unknown
      status: string
      start: number
      end: number | null
      output: { id: string; text: string } | null
      rejection: string | null
    }
  | { type: 'interrupt'; id: string; at: number; of: string }

const sessionsDir = (home: string): string => join(home, '.jot', 'sessions')
const commandsDir = (root: string): string => join(root, '.jot', 'commands')

const isPresent = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

// ---- The adapter: reads the logs.

interface IParse {
  sessionId: string
  messages: IMessageRecord[]
  parts: IPartRecord[]
  toolCalls: IToolCallRecord[]
  events: IEventRecord[]
}

const message = (
  parse: IParse,
  id: string,
  actor: IMessageRecord['actor'],
  at: number,
  fields: Partial<IMessageRecord> = {}
): IMessageRecord => {
  const record: IMessageRecord = {
    id: childIdOf(parse.sessionId, id),
    sessionId: parse.sessionId,
    seq: parse.messages.length,
    actor,
    sourceRole: actor,
    createdAt: at,
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
    ...fields,
  }
  parse.messages.push(record)
  return record
}

const part = (
  parse: IParse,
  messageId: string,
  kind: IPartRecord['kind'],
  text: string,
  toolCallId: string | null = null
): void => {
  const idx = parse.parts.filter((existing) => existing.messageId === messageId).length
  parse.parts.push({ messageId, sessionId: parse.sessionId, idx, kind, text, toolCallId })
}

const readTool = (parse: IParse, line: Extract<TLine, { type: 'tool' }>): void => {
  const id = childIdOf(parse.sessionId, line.id)
  const inputJson = JSON.stringify(line.input)
  parse.toolCalls.push({
    id,
    sessionId: parse.sessionId,
    messageId: childIdOf(parse.sessionId, line.in),
    name: line.tool,
    bareName: line.tool,
    server: null,
    family: line.family,
    inputJson,
    status: line.rejection === null ? (line.status as IToolCallRecord['status']) : 'error',
    childSessionId: null,
    startedAt: line.start,
    endedAt: line.end,
  })
  part(parse, childIdOf(parse.sessionId, line.in), 'tool_call', inputJson, id)
  if (line.output !== null) {
    const result = message(parse, line.output.id, 'tool', line.start)
    part(parse, result.id, 'tool_result', line.output.text, id)
  }
  if (line.rejection !== null) {
    parse.events.push({
      id: childIdOf(parse.sessionId, line.rejection),
      sessionId: parse.sessionId,
      kind: 'tool-rejected',
      at: line.end ?? line.start,
      dataJson: JSON.stringify({ toolCallId: id }),
    })
  }
}

const tokenFields = (tokens: readonly (number | null)[]): Partial<IMessageRecord> => {
  const [
    tokensInput = null,
    tokensOutput = null,
    tokensReasoning = null,
    tokensCacheRead = null,
    tokensCacheWrite = null,
  ] = tokens
  return { tokensInput, tokensOutput, tokensReasoning, tokensCacheRead, tokensCacheWrite }
}

const readAssistant = (parse: IParse, line: Extract<TLine, { type: 'assistant' }>): void => {
  const reply = message(parse, line.id, 'assistant', line.at, {
    completedAt: line.end,
    model: line.model,
    ...tokenFields(line.tokens),
  })
  if (line.thinking !== null) {
    part(parse, reply.id, 'reasoning', line.thinking)
  }
  if (line.text !== null) {
    part(parse, reply.id, 'text', line.text)
  }
}

const readLine = (parse: IParse, line: TLine): void => {
  if (line.type === 'user') {
    part(parse, message(parse, line.id, 'user', line.at).id, 'text', line.text)
  } else if (line.type === 'assistant') {
    readAssistant(parse, line)
  } else if (line.type === 'tool') {
    readTool(parse, line)
  } else if (line.type === 'interrupt') {
    parse.events.push({
      id: childIdOf(parse.sessionId, line.id),
      sessionId: parse.sessionId,
      kind: 'interrupted',
      at: line.at,
      dataJson: JSON.stringify({ messageId: childIdOf(parse.sessionId, line.of) }),
    })
  }
}

const importLog = async (path: string): Promise<IImportedUnit> => {
  const lines = (
    await readFile(path, 'utf8').catch(() => {
      throw new LogBookError(`${path} is gone.`, ADAPTER_ERROR_CODES.ADAPTER_UNIT_GONE)
    })
  )
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as TLine)
  const [head] = lines
  if (head?.type !== 'session') {
    throw new LogBookError(`${path} has no session line.`, ADAPTER_ERROR_CODES.ADAPTER_UNIT_UNREADABLE)
  }
  const parse: IParse = { sessionId: sessionIdOf(JOT_ID, head.id), messages: [], parts: [], toolCalls: [], events: [] }
  for (const line of lines.slice(1)) {
    readLine(parse, line)
  }
  const session: IImportedSession = {
    session: {
      id: parse.sessionId,
      harness: JOT_ID,
      sourceId: head.id,
      origin: 'interactive',
      isScripted: false,
      projectDir: head.cwd,
      title: head.title,
      agent: null,
      spawnedBySessionId: null,
      spawnedByToolCallId: null,
      ...timeSpan(parse.messages),
    },
    messages: parse.messages,
    parts: parse.parts,
    toolCalls: parse.toolCalls,
    events: parse.events,
  }
  return { sessions: [session], harnessVersion: head.version }
}

const commandNames = async (root: string): Promise<string[]> =>
  (await readdir(commandsDir(root)).catch(() => [])).map((file) => basename(file, '.md'))

const recogniser =
  (global: readonly string[], projects: ReadonlyMap<string, readonly string[]>) =>
  (prompt: IPrompt): IRecognisedCommand | null => {
    const name = /^\/(?<name>[a-z-]+)(?: |$)/u.exec(prompt.text)?.groups?.name
    if (prompt.actor !== 'user' || name === undefined) {
      return null
    }
    const project = prompt.projectDir === null ? [] : (projects.get(prompt.projectDir) ?? [])
    return { command: name, source: 'typed', hasFile: global.includes(name) || project.includes(name) }
  }

const jotAdapter: IHarnessAdapter = {
  descriptor: {
    id: JOT_ID,
    name: 'Jot',
    defaultAgent: 'main',
    unitNoun: 'logs',
    filterAlias: 'jot',
    parserVersion: 1,
    testedVersions: ['1.0'],
    locationVariables: [],
  },
  locate: async (env) => {
    const root = sessionsDir(env.homeDir)
    return (await isPresent(root))
      ? { kind: 'found', location: { root, kind: 'directory', describe: '~/.jot/sessions' } }
      : { kind: 'not-found', lookedAt: root }
  },
  openSource: async (location) =>
    Promise.resolve({
      formatDrift: null,
      listUnits: async () =>
        Promise.all(
          (await readdir(location.root)).toSorted().map(async (name) => {
            const { size, mtimeMs } = await stat(join(location.root, name))
            return { locator: name, fingerprint: `${String(size)}:${String(mtimeMs)}` }
          })
        ),
      importUnit: async (unit) => importLog(join(location.root, unit.locator)),
      close: async () => Promise.resolve(),
    }),
  prepareCommands: async (_location, env, projectDirs) => {
    const projects = await Promise.all(projectDirs.map(async (dir) => [dir, await commandNames(dir)] as const))
    return { recognise: recogniser(await commandNames(env.homeDir), new Map(projects)) }
  },
}

// ---- The writer: writes the logs and says what they import as.

interface IWriting {
  lines: TLine[]
  // The records the lines import as, built from the steps by the adapter's rules.
  expected: IParse
  ids: Map<string, string>
  counters: { msg: number; call: number; evt: number }
  sessionId: string
  reply: string | null
}

const next = (writing: IWriting, kind: keyof IWriting['counters']): string => {
  writing.counters[kind] += 1
  return `${kind}_demo${String(writing.counters[kind])}`
}

const record = (writing: IWriting, key: string, id: string): string => {
  writing.ids.set(key, childIdOf(writing.sessionId, id))
  return id
}

const writeCall = (writing: IWriting, step: Extract<ScriptStep, { kind: 'call' }>): void => {
  const id = record(writing, step.key, next(writing, 'call'))
  const callId = childIdOf(writing.sessionId, id)
  const replyId = writing.reply ?? ''
  const tool = TOOL_NAMES[step.family] ?? step.tool ?? ''
  const output = step.result === null ? null : { id: next(writing, 'msg'), text: step.result }
  const rejection = step.status === 'rejected' ? next(writing, 'evt') : null
  writing.lines.push({
    type: 'tool',
    id,
    in: replyId,
    tool,
    family: step.family,
    input: step.input,
    status: step.status,
    start: step.startAt,
    end: step.endAt,
    output,
    rejection,
  })
  const inputJson = JSON.stringify(step.input)
  const { expected } = writing
  expected.toolCalls.push({
    id: callId,
    sessionId: writing.sessionId,
    messageId: childIdOf(writing.sessionId, replyId),
    name: tool,
    bareName: tool,
    server: null,
    family: step.family,
    inputJson,
    status: step.status === 'rejected' ? 'error' : step.status,
    childSessionId: null,
    startedAt: step.startAt,
    endedAt: step.endAt,
  })
  part(expected, childIdOf(writing.sessionId, replyId), 'tool_call', inputJson, callId)
  if (output !== null) {
    part(expected, message(expected, output.id, 'tool', step.startAt).id, 'tool_result', output.text, callId)
  }
  if (rejection !== null) {
    expected.events.push({
      id: childIdOf(writing.sessionId, rejection),
      sessionId: writing.sessionId,
      kind: 'tool-rejected',
      at: step.endAt ?? step.startAt,
      dataJson: JSON.stringify({ toolCallId: callId }),
    })
  }
}

const writeUser = (writing: IWriting, key: string, at: number, text: string): void => {
  const id = record(writing, key, next(writing, 'msg'))
  writing.lines.push({ type: 'user', id, at, text })
  part(writing.expected, message(writing.expected, id, 'user', at).id, 'text', text)
}

const tokenList = (tokens: IScriptTokens | null): (number | null)[] =>
  tokens === null ? [] : [tokens.input, tokens.output, tokens.reasoning, tokens.cacheRead, tokens.cacheWrite]

const writeReply = (writing: IWriting, step: Extract<ScriptStep, { kind: 'reply' }>): void => {
  const id = record(writing, step.key, next(writing, 'msg'))
  writing.reply = id
  const tokens = tokenList(step.tokens)
  writing.lines.push({
    type: 'assistant',
    id,
    at: step.at,
    end: step.endAt,
    model: step.model,
    text: step.text,
    thinking: step.reasoning,
    tokens,
  })
  const reply = message(writing.expected, id, 'assistant', step.at, {
    completedAt: step.endAt,
    model: step.model,
    ...tokenFields(tokens),
  })
  if (step.reasoning !== null) {
    part(writing.expected, reply.id, 'reasoning', step.reasoning)
  }
  if (step.text !== null) {
    part(writing.expected, reply.id, 'text', step.text)
  }
}

const writeInterrupt = (writing: IWriting, step: Extract<ScriptStep, { kind: 'interrupt' }>): void => {
  const id = record(writing, step.key, next(writing, 'evt'))
  const of = writing.reply ?? ''
  writing.lines.push({ type: 'interrupt', id, at: step.at, of })
  writing.expected.events.push({
    id: childIdOf(writing.sessionId, id),
    sessionId: writing.sessionId,
    kind: 'interrupted',
    at: step.at,
    dataJson: JSON.stringify({ messageId: childIdOf(writing.sessionId, of) }),
  })
}

const writeStep = (writing: IWriting, step: ScriptStep): void => {
  if (step.kind === 'prompt') {
    writeUser(writing, step.key, step.at, step.text)
  } else if (step.kind === 'command') {
    writeUser(writing, step.key, step.at, `/${step.name} ${step.arguments}`.trim())
  } else if (step.kind === 'reply') {
    writeReply(writing, step)
  } else if (step.kind === 'call') {
    writeCall(writing, step)
  } else if (step.kind === 'interrupt') {
    writeInterrupt(writing, step)
  } else {
    throw new LogBookError(
      `Script ${step.key}: jot cannot record a ${step.kind} step.`,
      SOURCE_WRITER_ERROR_CODES.WRITER_SCRIPT_UNSUPPORTED
    )
  }
}

const lastTime = (script: ISessionScript): number =>
  Math.max(...script.steps.map((step) => ('at' in step ? step.at : (step.endAt ?? step.startAt))))

const failIfPresent = async (path: string, home: string): Promise<void> => {
  if (await isPresent(path)) {
    throw new LogBookError(`${relative(home, path)} exists.`, SOURCE_WRITER_ERROR_CODES.WRITER_TARGET_EXISTS)
  }
}

const expectedSession = (script: ISessionScript, sourceId: string, expected: IParse): IImportedSession => ({
  session: {
    id: expected.sessionId,
    harness: JOT_ID,
    sourceId,
    origin: 'interactive',
    isScripted: false,
    projectDir: script.projectDir,
    title: script.title,
    agent: null,
    spawnedBySessionId: null,
    spawnedByToolCallId: null,
    ...timeSpan(expected.messages),
  },
  messages: expected.messages,
  parts: expected.parts,
  toolCalls: expected.toolCalls,
  events: expected.events,
})

const jotWriter = (projectRoot: (home: string, projectDir: string) => string = projectDirIn): ISourceWriter => {
  const capabilities = new Set<SourceCapability>(['typed-command', 'interrupt', 'tool-reject'])
  const families = new Set<ScriptFamily>(['shell', 'read', 'other', 'dispatch'])
  return {
    capabilities,
    families,
    writeCommandFiles: async (home, files: readonly ICommandFile[]) => {
      checkCommandFiles(files)
      const paths = files.map((file) =>
        join(commandsDir(file.projectDir === null ? home : projectRoot(home, file.projectDir)), `${file.name}.md`)
      )
      await Promise.all(paths.map(async (path) => failIfPresent(path, home)))
      await Promise.all(
        files.map(async (file, index) => {
          const path = paths[index] ?? ''
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, file.body)
        })
      )
      return paths.map((path) => relative(home, path))
    },
    writeSessions: async (home, scripts): Promise<IWrittenSource> => {
      checkScripts({ capabilities, families }, scripts, ['1.0'])
      const ids = new Map<string, string>()
      const counters = { msg: 0, call: 0, evt: 0 }
      const logs = scripts.map((script, index) => {
        const sourceId = `demo${String(index + 1)}`
        const sessionId = sessionIdOf(JOT_ID, sourceId)
        const expected: IParse = { sessionId, messages: [], parts: [], toolCalls: [], events: [] }
        const writing: IWriting = { lines: [], expected, ids, counters, sessionId, reply: null }
        ids.set(script.key, writing.sessionId)
        writing.lines.push({
          type: 'session',
          id: sourceId,
          cwd: script.projectDir,
          title: script.title,
          version: script.harnessVersion ?? JOT_VERSION,
        })
        for (const step of script.steps) {
          writeStep(writing, step)
        }
        return {
          path: join(sessionsDir(home), `${sourceId}.jsonl`),
          lines: writing.lines,
          at: lastTime(script),
          session: expectedSession(script, sourceId, expected),
        }
      })
      await Promise.all(logs.map(async ({ path }) => failIfPresent(path, home)))
      await mkdir(sessionsDir(home), { recursive: true })
      await Promise.all(
        logs.map(async ({ path, lines, at }) => {
          await writeFile(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
          await utimes(path, new Date(at), new Date(at))
        })
      )
      return {
        expected: logs.map(({ session }) => session),
        ids,
        files: logs.map(({ path }) => relative(home, path)),
      }
    },
  }
}

// ---- The scripts.

const SCRIPTS: readonly ISessionScript[] = [
  {
    key: 'shop-1',
    projectDir: '/home/example/work/shop',
    title: 'Add a discount code field',
    agent: null,
    gitBranch: null,
    isScripted: false,
    harnessVersion: null,
    steps: [
      { kind: 'prompt', key: 'p1', at: 1_000, text: 'add a discount code field to checkout', images: 0 },
      {
        kind: 'reply',
        key: 'r1',
        at: 1_100,
        endAt: 1_200,
        model: 'model-a',
        text: 'Reading the form.',
        reasoning: 'It lives in src/checkout.',
        tokens: { input: 1200, output: 40, reasoning: null, cacheRead: 900, cacheWrite: 0 },
        cost: null,
      },
      {
        kind: 'call',
        key: 'c1',
        family: 'read',
        intent: 'read',
        tool: null,
        server: null,
        input: { path: '/home/example/work/shop/src/checkout/checkout-form.tsx' },
        status: 'completed',
        result: 'export const CheckoutForm = () => null',
        startAt: 1_200,
        endAt: 1_250,
      },
      {
        kind: 'call',
        key: 'c2',
        family: 'shell',
        intent: 'run',
        tool: null,
        server: null,
        input: { command: 'git push' },
        status: 'rejected',
        result: null,
        startAt: 1_250,
        endAt: 1_300,
      },
      { kind: 'command', key: 'm1', at: 1_400, name: 'release', arguments: 'shop', body: null },
      {
        kind: 'reply',
        key: 'r2',
        at: 1_500,
        endAt: 1_600,
        model: 'model-a',
        text: 'Running the tests.',
        reasoning: null,
        tokens: null,
        cost: null,
      },
      {
        kind: 'call',
        key: 'c3',
        family: 'shell',
        intent: 'run',
        tool: null,
        server: null,
        input: { command: 'pnpm test' },
        status: 'pending',
        result: null,
        startAt: 1_600,
        endAt: null,
      },
      { kind: 'interrupt', key: 'i1', at: 1_700 },
    ],
  },
  {
    key: 'billing-1',
    projectDir: '/home/example/work/billing',
    title: null,
    agent: null,
    gitBranch: null,
    isScripted: false,
    harnessVersion: '1.0.5',
    steps: [
      { kind: 'prompt', key: 'p2', at: 5_000, text: 'fix rounding in invoice totals', images: 0 },
      {
        kind: 'reply',
        key: 'r3',
        at: 5_100,
        endAt: 5_200,
        model: 'model-b',
        text: 'Probing the service.',
        reasoning: null,
        tokens: null,
        cost: null,
      },
      {
        kind: 'call',
        key: 'c4',
        family: 'other',
        intent: null,
        tool: 'probe',
        server: null,
        input: { target: 'invoices' },
        status: 'error',
        result: 'The probe timed out.',
        startAt: 5_200,
        endAt: 5_300,
      },
      {
        kind: 'call',
        key: 'c5',
        family: 'dispatch',
        intent: null,
        tool: null,
        server: null,
        input: {},
        status: 'completed',
        result: 'dispatched',
        startAt: 5_300,
        endAt: 5_400,
      },
      { kind: 'command', key: 'm2', at: 5_500, name: 'deploy', arguments: '', body: null },
    ],
  },
]

const COMMAND_FILES: readonly ICommandFile[] = [
  {
    name: 'release',
    body: 'Release the project named in the arguments and report the version: $ARGUMENTS',
    projectDir: null,
  },
  {
    name: 'review',
    body: 'Review the open changes of this project and list what to fix first: $ARGUMENTS',
    projectDir: '/home/example/work/shop',
  },
]

const caseNamed = (writer: ISourceWriter, name: string): (() => Promise<void>) => {
  const found = roundTripCases(jotAdapter, writer, SCRIPTS, COMMAND_FILES).find((candidate) => candidate.name === name)
  if (found === undefined) {
    throw new Error(`No round-trip case is named ${name}`)
  }
  return found.run
}

describe('roundTripCases for a minimal writer and adapter pair', () => {
  it.each(roundTripCases(jotAdapter, jotWriter(), SCRIPTS, COMMAND_FILES).map((testCase) => [testCase.name, testCase]))(
    '%s',
    async (_name, testCase) => {
      // Act
      const run = testCase.run()

      // Assert
      await expect(run).resolves.toBeUndefined()
    }
  )
})

describe('roundTripCases against broken writers', () => {
  it('fails R1, naming the field, for a writer whose expected differs by one field', async () => {
    // Arrange
    const writer = jotWriter()
    const changed: ISourceWriter = {
      ...writer,
      writeSessions: async (home, scripts) => {
        const written = await writer.writeSessions(home, scripts)
        const [first, ...rest] = written.expected
        return {
          ...written,
          expected:
            first === undefined ? rest : [{ ...first, session: { ...first.session, title: 'Changed title' } }, ...rest],
        }
      },
    }

    // Act
    const run = caseNamed(changed, 'R1 round trip')()

    // Assert
    await expect(run).rejects.toThrow(/title/u)
  })

  it('fails R1 for a writer that leaves a file it does not return', async () => {
    // Arrange
    const writer = jotWriter()
    const leaky: ISourceWriter = {
      ...writer,
      writeSessions: async (home, scripts) => {
        const written = await writer.writeSessions(home, scripts)
        await writeFile(join(home, '.jot', 'notes.txt'), 'left behind')
        return written
      },
    }

    // Act
    const run = caseNamed(leaky, 'R1 round trip')()

    // Assert
    await expect(run).rejects.toThrow(/notes\.txt/u)
  })

  it('fails R6 for a writer that puts a project command file below <home>/<projectDir>', async () => {
    // Arrange
    const misplaced = jotWriter((home, projectDir) => join(home, projectDir))

    // Act
    const run = caseNamed(misplaced, 'R6 project command')()

    // Assert
    await expect(run).rejects.toThrow(/ship-check/u)
  })
})
