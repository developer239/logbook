import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADAPTER_ERROR_CODES, KNOWN_TOOLS } from '@log-book/adapter-api'
import { conformanceCases, roundTripCases } from '@log-book/adapter-api/conformance'
import type { ISessionScript, ScriptStep } from '@log-book/adapter-api/source-writer'
import { openSqlite } from '@log-book/core'
import { describe, expect, it } from 'vitest'
import { COMMAND_FILES, SCRIPTS } from '../fixtures/2.0/scripts.js'
import { fixtureSet20, schemaWithout } from '../fixtures/fixture-set.js'
import { openCode } from './adapter.js'
import { toolNameOf } from './families.js'
import { openCodeSourceWriter } from './source-writer/index.js'

const FIXTURE_20 = fileURLToPath(new URL('../fixtures/2.0', import.meta.url))
const DATABASE = '.local/share/opencode/opencode.db'

// A call of a family only KNOWN_TOOLS names here, built at test time because no committed file may name one.
const knownToolScript = (
  family: 'dispatch' | 'wait',
  call: Partial<Extract<ScriptStep, { kind: 'call' }>>
): ISessionScript => ({
  key: `written-${family}`,
  projectDir: '/home/example/work/shop',
  title: null,
  agent: null,
  gitBranch: null,
  isScripted: false,
  harnessVersion: null,
  steps: [
    { kind: 'prompt', key: `${family}-p1`, at: 1_000, text: 'start the review run', images: 0 },
    {
      kind: 'reply',
      key: `${family}-r1`,
      at: 1_100,
      endAt: 1_200,
      model: 'model-a',
      text: 'Starting it.',
      reasoning: null,
      tokens: null,
      cost: null,
    },
    {
      kind: 'call',
      key: `${family}-c1`,
      family,
      intent: null,
      tool: null,
      server: null,
      input: {},
      status: 'completed',
      result: 'started',
      startAt: 1_200,
      endAt: 1_300,
      ...call,
    },
  ],
})

const KNOWN_TOOL_SCRIPTS = [
  knownToolScript('dispatch', { input: { prompt: 'review the coupon change' } }),
  knownToolScript('wait', { intent: 'output', input: { task: 'run-1' } }),
]

const parsedData = (text: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

// A row's shape: its type and the keys of its data, and for a tool of OpenCode's own table, its name and input keys.
// A row whose data does not parse has none.
const shapesOf = (rows: readonly { type: string; data: string }[]): string[] =>
  rows.flatMap(({ type, data: text }) => {
    const data = parsedData(text)
    if (data === null) {
      return []
    }
    const content = Array.isArray(data.content) ? (data.content as Record<string, unknown>[]) : []
    const tools = content.flatMap((part) => {
      const name = typeof part.name === 'string' ? part.name : ''
      const isOwn = part.type === 'tool' && toolNameOf(name).family !== 'other' && !KNOWN_TOOLS.has(name.toLowerCase())
      const input = (part.state as { input?: object } | undefined)?.input ?? {}
      return isOwn ? [`tool ${name} ${Object.keys(input).toSorted().join(',')}`] : []
    })
    return [`${type} ${Object.keys(data).toSorted().join(',')}`, ...tools]
  })

const rowShapes = async (path: string): Promise<Set<string>> => {
  const db = await openSqlite(path, { isReadOnly: true })
  try {
    return new Set(
      shapesOf(db.prepare('SELECT type, data FROM session_message').all() as { type: string; data: string }[])
    )
  } finally {
    db.close()
  }
}

describe('the OpenCode adapter on the conformance suite', () => {
  it.each(conformanceCases(openCode(), [fixtureSet20]).map((testCase) => [testCase.name, testCase]))(
    '%s',
    async (_name, testCase) => {
      // Act
      const run = testCase.run()

      // Assert
      await expect(run).resolves.toBeUndefined()
    }
  )

  it('2.0: refuses a database without session_message.data, naming the table and column', async () => {
    // Arrange
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-opencode-missing-')))
    try {
      await mkdir(directory, { recursive: true })
      const root = join(directory, 'opencode.db')
      const db = await openSqlite(root, { isReadOnly: false })
      db.exec(schemaWithout('session_message', 'data'))
      db.close()

      // Act
      const opened = openCode().openSource(
        { root, kind: 'file', describe: 'opencode.db' },
        {
          signal: new AbortController().signal,
          onProgress: () => undefined,
          openSqlite,
        }
      )

      // Assert
      await expect(opened).rejects.toMatchObject({
        code: ADAPTER_ERROR_CODES.ADAPTER_FORMAT_UNSUPPORTED,
        message: 'the database has no column session_message.data',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('the OpenCode source writer on the round trip', () => {
  it.each(
    roundTripCases(openCode(), openCodeSourceWriter(), [...SCRIPTS, ...KNOWN_TOOL_SCRIPTS], COMMAND_FILES).map(
      (testCase) => [testCase.name, testCase]
    )
  )('%s', async (_name, testCase) => {
    // Act
    const run = testCase.run()

    // Assert
    await expect(run).resolves.toBeUndefined()
  })

  it('writes only rows with a hand-written exemplar in set 2.0', async () => {
    // Arrange
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-opencode-exemplars-')))
    try {
      await openCodeSourceWriter().writeSessions(join(directory, 'written'), [...SCRIPTS, ...KNOWN_TOOL_SCRIPTS])
      const exemplars = await openSqlite(join(directory, 'exemplars.db'), { isReadOnly: false })
      exemplars.exec('PRAGMA foreign_keys = OFF')
      exemplars.exec(await readFile(join(FIXTURE_20, 'opencode.sql'), 'utf8'))
      exemplars.exec(await readFile(join(FIXTURE_20, 'rows.sql'), 'utf8'))
      exemplars.close()

      // Act
      const [written, handWritten] = await Promise.all([
        rowShapes(join(directory, 'written', DATABASE)),
        rowShapes(join(directory, 'exemplars.db')),
      ])

      // Assert
      expect([...written].filter((shape) => !handWritten.has(shape))).toStrictEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
