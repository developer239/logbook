import type { LinkConfidence } from '@log-book/warehouse'

export interface IPlacementTurn {
  sessionId: string
  // The turn's first message, which is the turn's id.
  messageId: string
  startedAt: number
  endedAt: number
}

export interface IPlacementLink {
  parentSessionId: string
  parentToolCallId: string | null
  childSessionId: string
  confidence: LinkConfidence
}

// A tool call that can start a child session: the turn it belongs to and its times.
export interface IPlacementCall {
  turnId: string
  startedAt: number | null
  endedAt: number | null
}

// Where a turn of a started session sits: under the turn and the tool call of the session that started it.
export interface ITurnPlacement {
  parentTurnId: string
  parentToolCallId: string | null
}

// A child's first message can be stamped a moment before its parent call's own start, because the two come from
// different clocks and processes.
const CLOCK_SLACK_MS = 1000

const CONFIDENCE_RANK: Readonly<Record<LinkConfidence, number>> = { exact: 0, reconstructed: 1, ambiguous: 2 }

interface ICandidate extends ITurnPlacement {
  rank: number
  callStart: number
}

const candidatesOf = (
  turnsBySession: ReadonlyMap<string, readonly IPlacementTurn[]>,
  links: readonly IPlacementLink[],
  calls: ReadonlyMap<string, IPlacementCall>
): Map<string, ICandidate[]> => {
  const candidates = new Map<string, ICandidate[]>()
  for (const link of links) {
    const call = link.parentToolCallId === null ? undefined : calls.get(link.parentToolCallId)
    // An ambiguous link places nothing (several sessions could be its child), and a link that names no call has no
    // turn to sit under.
    if (link.confidence === 'ambiguous' || link.childSessionId === link.parentSessionId || call === undefined) {
      continue
    }
    for (const turn of turnsBySession.get(link.childSessionId) ?? []) {
      candidates.set(turn.messageId, [
        ...(candidates.get(turn.messageId) ?? []),
        {
          parentTurnId: call.turnId,
          parentToolCallId: link.parentToolCallId,
          rank: CONFIDENCE_RANK[link.confidence],
          callStart: call.startedAt ?? Number.NEGATIVE_INFINITY,
        },
      ])
    }
  }
  return candidates
}

// Places every turn of a started session under the call that started it, so a conversation reads as one tree. A
// subagent has one parent and takes all its turns. A turn has at most one parent: exact links win over reconstructed
// ones, and among links of one confidence the call that began last before the turn (a resumed session is continued by
// several calls). A turn never sits under one that began after it, nor under itself through its own descendants;
// such a candidate gives way to the next.
export const placeTurns = (
  turns: readonly IPlacementTurn[],
  links: readonly IPlacementLink[],
  calls: ReadonlyMap<string, IPlacementCall>
): Map<string, ITurnPlacement> => {
  const turnsBySession = new Map<string, IPlacementTurn[]>()
  for (const turn of turns) {
    turnsBySession.set(turn.sessionId, [...(turnsBySession.get(turn.sessionId) ?? []), turn])
  }
  const sessionOfTurn = new Map(turns.map((turn) => [turn.messageId, turn.sessionId]))
  const startOf = new Map(turns.map((turn) => [turn.messageId, turn.startedAt]))
  const placements = new Map<string, ITurnPlacement>()
  // Whether `turnId` is `ancestorId` or sits somewhere under it.
  const isUnder = (turnId: string, ancestorId: string): boolean => {
    for (
      let current: string | undefined = turnId;
      current !== undefined;
      current = placements.get(current)?.parentTurnId
    ) {
      if (current === ancestorId) {
        return true
      }
    }
    return false
  }
  const ordered = [...candidatesOf(turnsBySession, links, calls).entries()].toSorted(
    ([left], [right]) => (startOf.get(left) ?? 0) - (startOf.get(right) ?? 0)
  )
  for (const [turnId, options] of ordered) {
    const best = options
      .toSorted((left, right) => (left.rank === right.rank ? right.callStart - left.callStart : left.rank - right.rank))
      .find(
        (option) =>
          sessionOfTurn.get(option.parentTurnId) !== sessionOfTurn.get(turnId) &&
          (startOf.get(option.parentTurnId) ?? 0) <= (startOf.get(turnId) ?? 0) + CLOCK_SLACK_MS &&
          !isUnder(option.parentTurnId, turnId)
      )
    if (best !== undefined) {
      placements.set(turnId, { parentTurnId: best.parentTurnId, parentToolCallId: best.parentToolCallId })
    }
  }
  return placements
}
