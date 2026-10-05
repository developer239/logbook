import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { everything, seedRows, START } from '../testing/rows'
import { insert, seedWarehouse, type ITestWarehouse } from '../testing/warehouse'
import { MINUTE, SECOND } from '../time'
import type * as Effort from './effort'
import type * as Loops from './loops'
import type * as Problems from './problems'
import type * as Strip from './strip'
import type * as ToolTokens from './tool-tokens'
import type * as Tools from './tools'
import type * as Unfinished from './unfinished'

const seed = (db: DatabaseSync): void => {
  seedRows(db)
  insert(db, 'tool_call', {
    id: 'c-docs',
    session_id: 'ses-me',
    message_id: 'm-me-5',
    name: 'mcp__claude_ai_Docs__notes_add',
    family: 'mcp:claude_ai_Docs',
    input_json: '{}',
    status: 'completed',
    started_at: START + 11 * MINUTE + 40 * SECOND,
    ended_at: START + 11 * MINUTE + 41 * SECOND,
  })
}

let warehouse: ITestWarehouse
let strip: typeof Strip
let unfinished: typeof Unfinished
let loops: typeof Loops
let problems: typeof Problems
let effort: typeof Effort
let toolTokens: typeof ToolTokens
let tools: typeof Tools

beforeAll(async () => {
  warehouse = seedWarehouse(seed)
  strip = await import('./strip')
  unfinished = await import('./unfinished')
  loops = await import('./loops')
  problems = await import('./problems')
  effort = await import('./effort')
  toolTokens = await import('./tool-tokens')
  tools = await import('./tools')
})

afterAll(() => {
  warehouse.remove()
})

describe('stripFor', () => {
  it('should total the range: conversations by starter, work time, calls and failures', () => {
    const { current, previous } = strip.stripFor(everything())

    expect(previous).toBeNull()
    expect(current).toEqual({
      conversations: 3,
      by: { me: 1, agent: 1, script: 1 },
      activeMs: 5 * MINUTE + 30 * SECOND,
      done: 2,
      calls: 10,
      failed: 5,
      realResults: 1,
    })
  })

  it('should total the range before it for a range that has one', () => {
    const range = { ...everything(), from: START + 60 * MINUTE, previous: { from: 0, to: START + 60 * MINUTE } }

    const { current, previous } = strip.stripFor(range)

    expect(current).toMatchObject({ conversations: 1, calls: 0 })
    expect(previous).toMatchObject({ conversations: 2, calls: 10, failed: 5 })
  })
})

describe('unfinished', () => {
  it('should list the conversations that did not finish, and how many the range has', () => {
    expect(unfinished.unfinished(everything())).toEqual({
      rows: [
        {
          sessionId: 'ses-me',
          outcome: 'failed',
          note: 'tests still red',
          title: 'Fix the widget',
          at: START + 30 * MINUTE,
        },
      ],
      conversationTotal: 3,
    })
  })
})

describe('retryLoops', () => {
  it('should find a tool called with the same input again and again, failing', () => {
    expect(loops.retryLoops(everything())).toEqual({
      loops: [
        {
          sessionId: 'ses-me',
          title: 'Fix the widget',
          name: 'Edit',
          input: '{"file_path":"/work/widgets/a.ts","old_string":"x"}',
          tries: 3,
          failed: 3,
          firstCallId: 'c-edit-1',
          turnId: 'm-me-1',
          spanMs: 4 * SECOND,
        },
      ],
      tries: 3,
      byTool: [{ name: 'Edit', loops: 1 }],
    })
  })
})

describe('toolProblems', () => {
  it('should group the failures that were a problem by cause as shown, the commonest first', () => {
    const { causes, failed, realResults, bugs } = problems.toolProblems(everything())

    expect(causes.map((cause) => [cause.cause, cause.calls, cause.roseFrom])).toEqual([
      ['Called the tool wrong', 2, null],
      ["Edit didn't match the file", 1, null],
      ['Not labelled yet', 1, null],
    ])
    expect(causes[0]?.tools.toSorted()).toEqual(['Bash', 'Edit'])
    expect(failed).toBe(4)
    expect(realResults).toBe(1)
    expect(bugs).toEqual([])
  })

  it('should count the failures of the last seven days, all of them in the week', () => {
    const { causes } = problems.toolProblems(everything())

    expect(causes.map((cause) => cause.dailyFailures.length)).toEqual([7, 7, 7])
    expect(causes.map((cause) => cause.dailyFailures.reduce((total, day) => total + day, 0))).toEqual([2, 1, 1])
  })
})

describe('effort', () => {
  it('should count conversations by kind of work and by who started them', () => {
    const { goals, notWork, unlabelled } = effort.goalMix(everything())

    expect(goals.toSorted((left, right) => left.goal.localeCompare(right.goal))).toEqual([
      { goal: 'build a feature', by: { me: 0, agent: 0, script: 1 } },
      { goal: 'fix a bug', by: { me: 1, agent: 0, script: 0 } },
      { goal: 'review', by: { me: 0, agent: 1, script: 0 } },
    ])
    expect(notWork).toBe(0)
    expect(unlabelled).toBe(0)
  })

  it('should show no goal a typical value where it has too few conversations', () => {
    expect(effort.tokensByGoal(everything())).toEqual({ rows: [], measuredConversations: 2, workConversations: 3 })
  })

  it('should time the turns I typed without the time spent waiting on my answers', () => {
    expect(effort.timePerTurn(everything())).toEqual({
      rows: [{ goal: null, turns: 2, typicalMs: 4 * MINUTE, oneInTenMs: null }],
      prompts: 2,
      longWaitShare: null,
    })
  })

  it('should time the conversations I started: how long the agent worked, and how long they ran', () => {
    expect(effort.timePerConversation(everything())).toEqual({
      rows: [{ goal: null, conversations: 1, activeMs: 4 * MINUTE, elapsedMs: 30 * MINUTE }],
      conversations: 1,
    })
  })
})

describe('toolTokens', () => {
  it('should estimate what a cookbook tool costs: its calls and its definition', () => {
    const notes = toolTokens
      .toolTokens(everything())
      .find((row) => row.name === 'notes_add' && row.source.name === 'notes')

    expect(notes).toEqual({
      name: 'notes_add',
      source: { kind: 'plugin', name: 'notes' },
      calls: 1,
      typicalTokens: 5,
      totalTokens: 5,
      definitionTokens: 9,
      isRetired: false,
    })
  })

  it('should list a tool the cookbook offers that was never called, with its definition', () => {
    const list = toolTokens.toolTokens(everything()).find((row) => row.name === 'notes_list')

    expect(list).toEqual({
      name: 'notes_list',
      source: { kind: 'plugin', name: 'notes' },
      calls: 0,
      typicalTokens: null,
      totalTokens: 0,
      definitionTokens: 10,
      isRetired: false,
    })
  })

  it('should not take another server tool for the cookbook tool it is named like', () => {
    const docs = toolTokens.toolTokens(everything()).find((row) => row.source.name === 'claude_ai_Docs')

    expect(docs).toMatchObject({ name: 'notes_add', calls: 1, definitionTokens: null, isRetired: false })
  })

  it('should count a skill by the text Claude Code loaded for it', () => {
    const skill = toolTokens.toolTokens(everything()).find((row) => row.source.kind === 'skills')

    expect(skill).toMatchObject({
      name: 'writing',
      calls: 1,
      typicalTokens: 15,
      totalTokens: 15,
      definitionTokens: null,
    })
  })
})

describe('offeredTools', () => {
  it('should read the cookbook tools by lower case name, with the size of each definition', () => {
    const offered = [...tools.offeredTools()].map(([key, tool]) => [key, { ...tool }])

    expect(offered).toEqual([
      ['notes_add', { module: 'notes', name: 'notes_add', definitionChars: 36 }],
      ['notes_list', { module: 'notes', name: 'notes_list', definitionChars: 41 }],
    ])
  })
})
