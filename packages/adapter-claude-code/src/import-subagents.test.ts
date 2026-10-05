import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateImportedUnit, type IImportedUnit } from '@log-book/adapter-api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeCode } from './adapter.js'
import { importTranscript } from './import-transcript.js'

const MAIN = 'claude-code:session-1'
const LOCATOR = '-home-example-work-shop/session-1.jsonl'

const stamp = (seconds: number): string => new Date(Date.UTC(2026, 0, 2, 10, 0, seconds)).toISOString()

type TLine = Record<string, unknown>

const prompt = (uuid: string, seconds: number, text: string): TLine => ({
  type: 'user',
  uuid,
  timestamp: stamp(seconds),
  message: { role: 'user', content: text },
})

// A reply that starts an agent, and the result line that reports the agent id.
const agentCall = (prefix: string, seconds: number, callId: string, agentType: string, agentId: string): TLine[] => [
  {
    type: 'assistant',
    uuid: `${prefix}-a`,
    timestamp: stamp(seconds),
    message: {
      id: `msg_${prefix}`,
      model: 'claude-sonnet-5-5',
      content: [
        {
          type: 'tool_use',
          id: callId,
          name: 'Agent',
          input: { description: 'Look', prompt: 'look around', subagent_type: agentType },
        },
      ],
    },
  },
  {
    type: 'user',
    uuid: `${prefix}-r`,
    timestamp: stamp(seconds + 1),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: 'Done.' }] },
    toolUseResult: { status: 'completed', agentId, prompt: 'look around' },
  },
]

const writeLines = async (path: string, lines: readonly TLine[]): Promise<void> => {
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
}

const linkOf = (unit: IImportedUnit, sessionId: string): unknown[] => {
  const found = unit.sessions.find(({ session }) => session.id === sessionId)?.session
  return [found?.sourceId, found?.spawnedBySessionId, found?.spawnedByToolCallId, found?.agent]
}

const childOf = (unit: IImportedUnit, callId: string): string | null | undefined =>
  unit.sessions.flatMap((session) => session.toolCalls).find((call) => call.id === callId)?.childSessionId

describe('importTranscript subagents', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-claude-subagents-')))
    await mkdir(join(directory, 'session-1', 'subagents'), { recursive: true })
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const importUnit = async (): Promise<IImportedUnit> => {
    const subagents = join(directory, 'session-1', 'subagents')
    await writeLines(join(directory, 'session-1.jsonl'), [
      prompt('m1', 0, 'explore the cart'),
      ...agentCall('m2', 1, 'toolu_1', 'Explore', 'a1'),
    ])
    await writeLines(join(subagents, 'agent-a1.jsonl'), [
      prompt('s1', 2, 'look around'),
      ...agentCall('s2', 3, 'toolu_2', 'general-purpose', 'b2'),
    ])
    await writeLines(join(subagents, 'agent-b2.jsonl'), [prompt('n1', 4, 'look deeper')])
    await writeLines(join(subagents, 'agent-c3.jsonl'), [prompt('o1', 5, 'started by a deleted parent')])
    return importTranscript(join(directory, 'session-1.jsonl'), LOCATOR)
  }

  it('links a top-level subagent both ways, with its agent type', async () => {
    // Act
    const unit = await importUnit()

    // Assert
    expect({
      link: linkOf(unit, `${MAIN}/agent-a1`),
      child: childOf(unit, `${MAIN}/toolu_1`),
      problems: validateImportedUnit(claudeCode().descriptor, unit),
    }).toStrictEqual({
      link: ['session-1/agent-a1', MAIN, `${MAIN}/toolu_1`, 'Explore'],
      child: `${MAIN}/agent-a1`,
      problems: [],
    })
  })

  it('gives a subagent started by another subagent that subagent as parent and its call', async () => {
    // Act
    const unit = await importUnit()

    // Assert
    expect({ link: linkOf(unit, `${MAIN}/agent-b2`), child: childOf(unit, `${MAIN}/agent-a1/toolu_2`) }).toStrictEqual({
      link: ['session-1/agent-b2', `${MAIN}/agent-a1`, `${MAIN}/agent-a1/toolu_2`, 'general-purpose'],
      child: `${MAIN}/agent-b2`,
    })
  })

  it('keeps the main session as parent of an orphan subagent, with no call or agent', async () => {
    // Act
    const unit = await importUnit()

    // Assert
    expect({
      link: linkOf(unit, `${MAIN}/agent-c3`),
      sessions: unit.sessions.map(({ session }) => session.id),
    }).toStrictEqual({
      link: ['session-1/agent-c3', MAIN, null, null],
      sessions: [MAIN, `${MAIN}/agent-a1`, `${MAIN}/agent-b2`, `${MAIN}/agent-c3`],
    })
  })
})
