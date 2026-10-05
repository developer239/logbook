import { readdir, readFile, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { conformanceCases, roundTripCases } from '@log-book/adapter-api/conformance'
import type { ISessionScript } from '@log-book/adapter-api/source-writer'
import { describe, expect, it } from 'vitest'
import { COMMAND_FILES, SCRIPTS } from '../fixtures/2.1/scripts.js'
import { fixtureSet21 } from '../fixtures/fixture-set.js'
import { claudeCode } from './adapter.js'
import { toolNameOf } from './families.js'
import { lineKind } from './line-events.js'
import { claudeCodeSourceWriter } from './source-writer/index.js'

const HOME_21 = fileURLToPath(new URL('../fixtures/2.1/home', import.meta.url))

// A dispatch call, built at test time because no committed file may name a KNOWN_TOOLS tool.
const DISPATCH_SCRIPT: ISessionScript = {
  key: 'written-dispatch',
  projectDir: '/home/example/work/shop',
  title: null,
  agent: null,
  gitBranch: null,
  isScripted: false,
  harnessVersion: null,
  steps: [
    { kind: 'prompt', key: 'd-p1', at: 1_000, text: 'start the review run', images: 0 },
    {
      kind: 'reply',
      key: 'd-r1',
      at: 1_100,
      endAt: 1_200,
      model: 'claude-sonnet-5-5',
      text: 'Starting it.',
      reasoning: null,
      tokens: null,
      cost: null,
    },
    {
      kind: 'call',
      key: 'd-c1',
      family: 'dispatch',
      intent: null,
      tool: null,
      server: 'orchestra',
      input: { prompt: 'review the coupon change' },
      status: 'completed',
      result: 'started',
      startAt: 1_200,
      endAt: 1_300,
    },
  ],
}

const parsedLine = (raw: string): (Record<string, unknown> & { message?: Record<string, unknown> }) | null => {
  try {
    return JSON.parse(raw) as Record<string, unknown> & { message?: Record<string, unknown> }
  } catch {
    return null
  }
}

const toolShapes = (message: Record<string, unknown> | undefined): string[] => {
  const content = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : []
  return content.flatMap((block) => {
    const name = typeof block.name === 'string' ? block.name : ''
    const { family, server } = toolNameOf(name)
    const isOwn = block.type === 'tool_use' && server === null && family !== 'other'
    return isOwn
      ? [
          `tool ${name} ${Object.keys(block.input as object)
            .toSorted()
            .join(',')}`,
        ]
      : []
  })
}

// What makes a record's shape: its kind, its top-level and message keys, and for an own-table tool its name and input
// keys. A line that does not parse is no record.
const shapesOf = (text: string): string[] =>
  text.split('\n').flatMap((raw) => {
    const line = parsedLine(raw)
    if (line === null) {
      return []
    }
    const keys = Object.keys(line).toSorted().join(',')
    const messageKeys = Object.keys(line.message ?? {})
      .toSorted()
      .join(',')
    return [`${lineKind(line)} ${keys} ${messageKeys}`, ...toolShapes(line.message)]
  })

const transcriptShapes = async (home: string): Promise<Set<string>> => {
  const entries = await readdir(home, { recursive: true, withFileTypes: true })
  const texts = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map(async (entry) => readFile(join(entry.parentPath, entry.name), 'utf8'))
  )
  return new Set(texts.flatMap((text) => shapesOf(text)))
}

describe('the Claude Code adapter on the conformance suite', () => {
  it.each(conformanceCases(claudeCode(), [fixtureSet21]).map((testCase) => [testCase.name, testCase]))(
    '%s',
    async (_name, testCase) => {
      // Act
      const run = testCase.run()

      // Assert
      await expect(run).resolves.toBeUndefined()
    }
  )
})

describe('the Claude Code source writer on the round trip', () => {
  it.each(
    roundTripCases(claudeCode(), claudeCodeSourceWriter(), [...SCRIPTS, DISPATCH_SCRIPT], COMMAND_FILES).map(
      (testCase) => [testCase.name, testCase]
    )
  )('%s', async (_name, testCase) => {
    // Act
    const run = testCase.run()

    // Assert
    await expect(run).resolves.toBeUndefined()
  })

  it('writes only records with a hand-written exemplar in set 2.1', async () => {
    // Arrange
    const home = await realpath(await mkdtemp(join(tmpdir(), 'log-book-claude-exemplars-')))
    try {
      await claudeCodeSourceWriter().writeSessions(home, [...SCRIPTS, DISPATCH_SCRIPT])

      // Act
      const [written, exemplars] = await Promise.all([transcriptShapes(home), transcriptShapes(HOME_21)])

      // Assert
      expect([...written].filter((shape) => !exemplars.has(shape))).toStrictEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
