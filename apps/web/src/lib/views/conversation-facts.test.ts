import { describe, expect, it } from 'vitest'
import type { IConversation } from '../queries/conversation'
import { conversationFacts } from './conversation-facts'

const head = (fields: Partial<IConversation> = {}): IConversation => ({
  id: 'claude-code:1',
  harness: 'claude-code',
  startedBy: 'me',
  agent: null,
  title: null,
  project: null,
  branch: null,
  model: null,
  startedAt: 0,
  endedAt: 90_000,
  activeMs: 30_000,
  steps: 1200,
  failed: 0,
  spawned: 2,
  compactions: 0,
  goal: 'fix a bug',
  outcome: 'done',
  outcomeNote: null,
  parent: null,
  ...fields,
})

const factOf = (label: string, fields: Partial<IConversation> = {}): ReturnType<typeof conversationFacts>[number] => {
  const fact = conversationFacts(head(fields)).find((row) => row.label === label)
  if (fact === undefined) {
    throw new Error(`No fact ${label}`)
  }

  return fact
}

describe('conversationFacts', () => {
  it('should say in words that a conversation has no recorded time, not show 0', () => {
    expect(factOf('Took', { endedAt: null }).value).toBe('no time recorded')
    expect(factOf('Took').value).toBe('1 min 30 s')
  })

  it('should put the failed steps beside the steps only when some failed', () => {
    expect(factOf('Steps')).toEqual({ label: 'Steps', value: '1,200' })
    expect(factOf('Steps', { failed: 3 })).toEqual({ label: 'Steps', value: '1,200', badge: '3 failed' })
  })

  it('should say who started it in words', () => {
    expect(factOf('Started by').value).toBe('me')
    expect(factOf('Started by', { startedBy: 'agent' }).value).toBe('an agent')
    expect(factOf('Started by', { startedBy: 'script' }).value).toBe('a script')
  })

  it('should say a compaction count as times, or never', () => {
    expect(factOf('Compacted').value).toBe('never')
    expect(factOf('Compacted', { compactions: 2 }).value).toBe('2×')
  })

  it('should show the outcome as a status with its note, and say when it is not labelled', () => {
    expect(factOf('Outcome', { outcomeNote: 'Shipped it.' })).toEqual({
      label: 'Outcome',
      value: 'done',
      statusTone: 'good',
      note: 'Shipped it.',
      isWide: true,
    })
    expect(factOf('Outcome', { outcome: null })).toMatchObject({ value: 'not labelled yet', statusTone: 'hollow' })
  })
})
