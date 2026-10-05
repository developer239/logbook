import { describe, expect, it } from 'vitest'
import { turnsOf, type IMessageRow, type IToolRow } from './session'

const message = (id: string, seq: number): IMessageRow => ({
  id,
  seq,
  actor: 'assistant',
  createdAt: seq,
  completedAt: null,
  model: null,
  text: null,
  reasoning: null,
  compactionSummary: null,
  tokensRead: null,
  tokensWritten: null,
})

const tool = (id: string, messageId: string): IToolRow => ({
  id,
  messageId,
  name: 'Read',
  family: 'file',
  status: 'completed',
  inputJson: '{}',
  startedAt: null,
  endedAt: null,
  output: null,
  purpose: null,
  label: null,
})

const turn = (id: string, seq: number, firstSeq: number): Parameters<typeof turnsOf>[0][number] => ({
  id,
  seq,
  firstSeq,
  startedAt: 0,
  endedAt: 0,
  modelMs: 0,
  toolMs: 0,
  idleMs: 0,
})

describe('turnsOf', () => {
  it('should give a turn the messages from its first one to the next turn first one', () => {
    const turns = turnsOf(
      [turn('t1', 0, 2), turn('t2', 1, 5)],
      [message('m1', 1), message('m2', 2), message('m3', 3), message('m4', 5), message('m5', 9)],
      []
    )

    expect(turns.map((row) => row.messages.map((each) => each.id))).toEqual([
      ['m2', 'm3'],
      ['m4', 'm5'],
    ])
  })

  it('should leave a message before the first turn to no turn', () => {
    const turns = turnsOf(
      [turn('t1', 0, 3)],
      [message('m1', 1), message('m2', 3)],
      [tool('c1', 'm1'), tool('c2', 'm2')]
    )

    expect(turns[0]?.messages.map((each) => each.id)).toEqual(['m2'])
    expect(turns[0]?.tools.map((each) => each.id)).toEqual(['c2'])
  })

  it('should give a turn the tools of its messages in the order they were listed', () => {
    const turns = turnsOf(
      [turn('t1', 0, 1), turn('t2', 1, 4)],
      [message('m1', 1), message('m2', 2), message('m3', 4)],
      [tool('c1', 'm3'), tool('c2', 'm1'), tool('c3', 'm2'), tool('c4', 'm1')]
    )

    expect(turns.map((row) => row.tools.map((each) => each.id))).toEqual([['c2', 'c3', 'c4'], ['c1']])
  })

  it('should hold nothing for a session with no turns', () => {
    expect(turnsOf([], [message('m1', 1)], [tool('c1', 'm1')])).toEqual([])
  })
})
