import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseFilter } from '../filter'
import { everything, seedRows, START } from '../testing/rows'
import { seedWarehouse, type ITestWarehouse } from '../testing/warehouse'
import { MINUTE } from '../time'
import type * as Conversation from './conversation'
import type * as Conversations from './conversations'

let warehouse: ITestWarehouse
let list: typeof Conversations
let one: typeof Conversation

beforeAll(async () => {
  warehouse = seedWarehouse(seedRows)
  list = await import('./conversations')
  one = await import('./conversation')
})

afterAll(() => {
  warehouse.remove()
})

const idsOf = (query: string): string[] =>
  list.conversations(parseFilter(query), everything(), 0).rows.map((row) => row.id)

describe('conversations', () => {
  it('should list every conversation of the range, the one worked on last first', () => {
    const { rows, total, pageSize } = list.conversations(parseFilter(''), everything(), 0)

    expect(rows.map((row) => row.id)).toEqual(['ses-script', 'ses-me', 'ses-agent'])
    expect(total).toBe(3)
    expect(pageSize).toBe(100)
  })

  it('should say what a conversation is: its title, who started it, its work and its labels', () => {
    const { rows } = list.conversations(parseFilter(''), everything(), 0)

    expect(rows.find((row) => row.id === 'ses-me')).toEqual({
      id: 'ses-me',
      title: 'Fix the widget',
      harness: 'claude-code',
      agent: null,
      startedBy: 'me',
      startedAt: START,
      lastAt: START + 11 * MINUTE,
      endedAt: START + 30 * MINUTE,
      activeMs: 4 * MINUTE,
      steps: 12,
      failed: 5,
      goal: 'fix a bug',
      outcome: 'failed',
    })
  })

  it('should title a conversation by its first typed prompt where it has no title', () => {
    const { rows } = list.conversations(parseFilter(''), everything(), 0)

    expect(rows.map((row) => [row.id, row.title, row.startedBy])).toEqual([
      ['ses-script', '[note] release v2 please', 'script'],
      ['ses-me', 'Fix the widget', 'me'],
      ['ses-agent', 'Review the widget', 'agent'],
    ])
  })

  it('should keep to the range', () => {
    const day = { ...everything(), from: START + 60 * MINUTE }

    expect(list.conversations(parseFilter(''), day, 0).rows.map((row) => row.id)).toEqual(['ses-script'])
  })

  it('should filter by the labels of a conversation, the newest label counting', () => {
    expect(idsOf('goal:"fix a bug"')).toEqual(['ses-me'])
    expect(idsOf('goal:"build a feature"')).toEqual(['ses-script'])
    expect(idsOf('outcome:done')).toEqual(['ses-script', 'ses-agent'])
  })

  it('should filter by who started it, its harness and its project', () => {
    expect(idsOf('by:agent')).toEqual(['ses-agent'])
    expect(idsOf('by:me,script')).toEqual(['ses-script', 'ses-me'])
    expect(idsOf('harness:claude')).toEqual(['ses-me', 'ses-agent'])
    expect(idsOf('project:widgets')).toEqual(['ses-me'])
    expect(idsOf('agent:reviewer')).toEqual(['ses-agent'])
  })

  it('should filter by what happened in it', () => {
    expect(idsOf('has:failures')).toEqual(['ses-me'])
    expect(idsOf('has:retry')).toEqual(['ses-me'])
    expect(idsOf('has:correction')).toEqual(['ses-me'])
    expect(idsOf('has:spawned')).toEqual(['ses-me'])
  })

  it('should filter by a tool called, a model used and a cause of failure', () => {
    expect(idsOf('tool:edit')).toEqual(['ses-me'])
    expect(idsOf('model:model-b')).toEqual(['ses-me'])
    expect(idsOf('cause:"Called the tool wrong"')).toEqual(['ses-me'])
    expect(idsOf('cause:"Tool bug"')).toEqual([])
  })

  it('should search the text of a conversation and its title', () => {
    expect(idsOf('release')).toEqual(['ses-script'])
    expect(idsOf('widget')).toEqual(['ses-me', 'ses-agent'])
    expect(idsOf('widget reviewer')).toEqual([])
  })

  it('should count the whole list for a page past its end', () => {
    expect(list.conversations(parseFilter(''), everything(), 4)).toMatchObject({ rows: [], total: 3 })
  })
})

describe('conversation', () => {
  it('should say what a conversation is and did', () => {
    expect(one.conversation('ses-me')).toEqual({
      id: 'ses-me',
      harness: 'claude-code',
      startedBy: 'me',
      agent: null,
      title: 'Fix the widget',
      project: '/work/widgets',
      branch: 'feature/widget',
      model: 'model-a',
      startedAt: START,
      endedAt: START + 30 * MINUTE,
      activeMs: 4 * MINUTE,
      steps: 12,
      failed: 5,
      spawned: 1,
      compactions: 1,
      goal: 'fix a bug',
      outcome: 'failed',
      outcomeNote: 'tests still red',
      parent: null,
    })
  })

  it('should name the turn that started a conversation an agent started', () => {
    expect(one.conversation('ses-agent')).toMatchObject({
      startedBy: 'agent',
      title: 'Review the widget',
      parent: { sessionId: 'ses-me', title: 'Fix the widget', turnId: 'm-me-1' },
    })
  })

  it('should be null where no conversation has the id', () => {
    expect(one.conversation('ses-none')).toBeNull()
  })
})

describe('turnPath', () => {
  it('should lead from a turn up through the agents that started it', () => {
    expect(one.turnPath('m-ag-1')).toEqual([
      { id: 'm-ag-1', sessionId: 'ses-agent' },
      { id: 'm-me-1', sessionId: 'ses-me' },
    ])
  })

  it('should be empty for a turn that does not exist', () => {
    expect(one.turnPath('m-none')).toEqual([])
  })
})
