import { describe, expect, it } from 'vitest'
import type { IConversationTime } from '../queries/effort'
import { HOUR, MINUTE } from '../time'
import { conversationTimeRows } from './time-per-conversation'

const conversation = (fields: Partial<IConversationTime>): IConversationTime => ({
  goal: null,
  conversations: 12,
  activeMs: 5 * MINUTE,
  elapsedMs: 2 * HOUR,
  ...fields,
})

describe('conversationTimeRows', () => {
  it('should put the time worked as the dot and the time from start to finish as the tick', () => {
    const { rows } = conversationTimeRows([conversation({})])

    expect(rows).toEqual([
      {
        label: 'All',
        title: 'All, 12 conversations',
        dot: 5 * MINUTE,
        tick: 2 * HOUR,
        lead: '5 min',
        trail: 'of 2 h',
      },
    ])
  })

  it('should name a goal and count its conversations in the hover', () => {
    const { rows } = conversationTimeRows([conversation({}), conversation({ goal: 'review', conversations: 1 })])

    expect(rows[1]).toMatchObject({ label: 'Review', title: 'Review, 1 conversation' })
  })

  it('should run the scale from a minute to the longest conversation, and at least ten minutes', () => {
    expect(conversationTimeRows([conversation({ elapsedMs: 3 * MINUTE })])).toMatchObject({
      floor: MINUTE,
      ceiling: 10 * MINUTE,
    })
    expect(conversationTimeRows([conversation({})]).ceiling).toBe(2 * HOUR)
  })

  it('should have no rows for no conversations', () => {
    expect(conversationTimeRows([]).rows).toEqual([])
  })
})
