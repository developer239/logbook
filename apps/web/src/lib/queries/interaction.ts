import type { IRange } from '../range'
import { REACTIONS } from '../sql'
import { addDays, startOfWeek } from '../time'
import { all } from '../warehouse'

export const TREND_REACTIONS = ['correction', 'pushback', 'praise'] as const

// The cookbook's reply codes worth comparing models on: asking permission for what it could just do, dropping a
// position without a new reason, and pushing back.
export const REPLY_HABITS = ['permission', 'caves', 'pushback'] as const

export const TREND_WEEKS = 8

export interface IShare<TKind extends string> {
  kind: TKind
  // Records in the range with the kind.
  count: number
  // The kind's share of each week's records, oldest week first; a week with no records counts as none.
  weekly: number[]
}

export interface IReactionTrend {
  // Prompts in the range the cookbook labelled.
  prompts: number
  reactions: IShare<(typeof TREND_REACTIONS)[number]>[]
}

export interface IModelReactions {
  model: string
  // Its labelled replies in the range.
  replies: number
  reactions: IShare<(typeof REPLY_HABITS)[number]>[]
}

interface IAt {
  at: number
}

type Within = (row: IAt) => boolean

interface ITrendWindow {
  // Where the rows to read start: the range's start or the first week's, whichever is earlier.
  from: number
  inRange: Within
  weeks: Within[]
}

const within =
  (from: number, to: number): Within =>
  (row) =>
    row.at >= from && row.at < to

// The weeks end with the range, whatever its start: a short range has no trend.
const trendWindow = (range: IRange): ITrendWindow => {
  const first = addDays(startOfWeek(range.to - 1), -7 * (TREND_WEEKS - 1))

  return {
    from: Math.min(first, range.from),
    inRange: within(range.from, range.to),
    weeks: Array.from({ length: TREND_WEEKS }, (_, index) => {
      const start = addDays(first, 7 * index)
      return within(start, addDays(start, 7))
    }),
  }
}

const sharesOf = <TKind extends string>(
  kinds: readonly TKind[],
  records: readonly IAt[],
  hits: readonly (IAt & { kind: string })[],
  window: ITrendWindow
): IShare<TKind>[] =>
  kinds.map((kind) => {
    const ofKind = hits.filter((hit) => hit.kind === kind)

    return {
      kind,
      count: ofKind.filter(window.inRange).length,
      weekly: window.weeks.map((isInWeek) => {
        const total = records.filter(isInWeek).length
        return total === 0 ? 0 : ofKind.filter(isInWeek).length / total
      }),
    }
  })

// A share is of the prompts with an `act` label holding at least one reaction of the kind.
export const reactionTrend = (range: IRange): IReactionTrend => {
  const window = trendWindow(range)
  const prompts = all<IAt>(
    `SELECT m.created_at AS at FROM message m
     WHERE m.created_at >= ? AND m.created_at < ? AND EXISTS (
       SELECT 1 FROM label a WHERE a.record_type = 'message' AND a.record_id = m.id AND a.name = 'act')`,
    window.from,
    range.to
  )
  const reactions = all<IAt & { kind: string }>(
    `SELECT DISTINCT r.message_id, r.reaction AS kind, m.created_at AS at
     FROM ${REACTIONS} r JOIN message m ON m.id = r.message_id
     WHERE r.reaction IN (${TREND_REACTIONS.map((reaction) => `'${reaction}'`).join(', ')})
       AND m.created_at >= ? AND m.created_at < ?`,
    window.from,
    range.to
  )

  return {
    prompts: prompts.filter(window.inRange).length,
    reactions: sharesOf(TREND_REACTIONS, prompts, reactions, window),
  }
}

// A reply's codes are one comma-joined label, from the newest labelling of it. A model is listed when it has
// labelled replies in the range, the busiest first.
export const agentReactions = (range: IRange): IModelReactions[] => {
  const window = trendWindow(range)
  const replies = all<IAt & { model: string; codes: string }>(
    `SELECT m.model, l.value AS codes, m.created_at AS at FROM label l JOIN message m ON m.id = l.record_id
     WHERE l.record_type = 'message' AND l.name = 'reply' AND m.model IS NOT NULL
       AND m.created_at >= ? AND m.created_at < ?
       AND l.labelled_at = (SELECT MAX(l2.labelled_at) FROM label l2
         WHERE l2.record_type = 'message' AND l2.record_id = l.record_id AND l2.name = 'reply')`,
    window.from,
    range.to
  )

  return [...Map.groupBy(replies, (reply) => reply.model)]
    .map(([model, ofModel]) => ({
      model,
      replies: ofModel.filter(window.inRange).length,
      reactions: sharesOf(
        REPLY_HABITS,
        ofModel,
        ofModel.flatMap((reply) => reply.codes.split(',').map((kind) => ({ at: reply.at, kind }))),
        window
      ),
    }))
    .filter((model) => model.replies > 0)
    .toSorted((left, right) => {
      const byReplies = right.replies - left.replies

      return byReplies === 0 ? left.model.localeCompare(right.model) : byReplies
    })
}
