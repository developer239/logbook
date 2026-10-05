import { describe, expect, it } from 'vitest'
import { placeTurns, type IPlacementCall, type IPlacementLink, type IPlacementTurn } from './turn-placement.js'

const turn = (sessionId: string, messageId: string, startedAt: number, endedAt = startedAt + 10): IPlacementTurn => ({
  sessionId,
  messageId,
  startedAt,
  endedAt,
})

const link = (overrides: Partial<IPlacementLink>): IPlacementLink => ({
  parentSessionId: 'parent',
  parentToolCallId: 'call-1',
  childSessionId: 'child',
  confidence: 'exact',
  ...overrides,
})

const PARENT_TURNS = [turn('parent', 'p1', 0, 1_000), turn('parent', 'p2', 2_000, 5_000)]
const CALLS = new Map<string, IPlacementCall>([
  ['call-1', { turnId: 'p1', startedAt: 100, endedAt: 900 }],
  ['call-2', { turnId: 'p2', startedAt: 2_100, endedAt: 4_000 }],
])

describe('placeTurns', () => {
  it('puts every turn of a subagent under its call', () => {
    // Arrange
    const turns = [...PARENT_TURNS, turn('sub', 's1', 150), turn('sub', 's2', 4_500)]

    // Act
    const placements = placeTurns(turns, [link({ childSessionId: 'sub' })], CALLS)

    // Assert
    expect(Object.fromEntries(placements)).toStrictEqual({
      s1: { parentTurnId: 'p1', parentToolCallId: 'call-1' },
      s2: { parentTurnId: 'p1', parentToolCallId: 'call-1' },
    })
  })

  it('gives a resumed session each turn under the call that began last before it, exact before reconstructed', () => {
    // Arrange: two calls continue one partner session; a reconstructed link also claims its second turn
    const turns = [...PARENT_TURNS, turn('partner', 'a1', 300), turn('partner', 'a2', 2_500)]
    const links = [
      link({ childSessionId: 'partner', parentToolCallId: 'call-1' }),
      link({ childSessionId: 'partner', parentToolCallId: 'call-2' }),
      link({ childSessionId: 'partner', parentToolCallId: 'call-1', confidence: 'reconstructed' }),
    ]

    // Act
    const placements = placeTurns(turns, links, CALLS)

    // Assert
    expect(Object.fromEntries(placements)).toStrictEqual({
      a1: { parentTurnId: 'p1', parentToolCallId: 'call-1' },
      a2: { parentTurnId: 'p2', parentToolCallId: 'call-2' },
    })
  })

  it('places nothing from an ambiguous link or from a link that names no call', () => {
    // Arrange
    const turns = [...PARENT_TURNS, turn('child', 'c1', 3_500), turn('maybe', 'm1', 300)]
    const links = [
      link({ childSessionId: 'maybe', confidence: 'ambiguous' }),
      link({ childSessionId: 'child', parentToolCallId: null }),
    ]

    // Act
    const placements = placeTurns(turns, links, CALLS)

    // Assert
    expect(Object.fromEntries(placements)).toStrictEqual({})
  })

  it('never puts a turn under one that began after it, nor under its own descendant', () => {
    // Arrange: a later child claims the parent back, and two turns a moment apart claim each other
    const turns = [turn('a', 'a1', 10_000, 20_000), turn('b', 'b1', 10_200, 20_000), turn('c', 'c1', 30_000)]
    const calls = new Map<string, IPlacementCall>([
      ['call-a', { turnId: 'a1', startedAt: 10_100, endedAt: 10_150 }],
      ['call-b', { turnId: 'b1', startedAt: 10_300, endedAt: 10_350 }],
      ['call-c', { turnId: 'c1', startedAt: 30_000, endedAt: 30_050 }],
    ])
    const links = [
      link({ parentSessionId: 'a', childSessionId: 'b', parentToolCallId: 'call-a' }),
      link({ parentSessionId: 'b', childSessionId: 'a', parentToolCallId: 'call-b' }),
      link({ parentSessionId: 'c', childSessionId: 'a', parentToolCallId: 'call-c' }),
    ]

    // Act
    const placements = placeTurns(turns, links, calls)

    // Assert: a1 and b1 are within the clock slack, so one sits under the other, never both ways
    expect(Object.fromEntries(placements)).toStrictEqual({ a1: { parentTurnId: 'b1', parentToolCallId: 'call-b' } })
  })
})
