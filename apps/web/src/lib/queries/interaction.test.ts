import type { IBuiltDemo } from '@log-book/demo'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { plannedLabel, reactionsOf, stepsOf } from '../../../test/plan-facts'
import { parseRange, type IRange } from '../range'
import { copyDemo, type ITestWarehouse } from '../testing/warehouse'
import { addDays, DAY, startOfWeek } from '../time'
import type * as Interaction from './interaction'

let demo: IBuiltDemo
let warehouse: ITestWarehouse
let queries: typeof Interaction

beforeAll(async () => {
  demo = inject('demoSmall')
  warehouse = await copyDemo('demoSmall')
  queries = await import('./interaction')
})

afterAll(async () => {
  await warehouse.remove()
})

interface IHit {
  at: number
  kind: string
}

const rangeOf = (query: string, now: number): IRange => parseRange(new URLSearchParams(query), now)

// A range of one day a week after the set, so every reaction is in a week before it.
const laterDay = (): IRange => rangeOf('range=today', demo.plan.plan.anchor + 7 * DAY)

const isWithin = (at: number, from: number, to: number): boolean => at >= from && at < to

// Each kind's count in the range, and its share of each week's records, the weeks ending with the range.
const sharesOf = <TKind extends string>(
  kinds: readonly TKind[],
  records: readonly number[],
  hits: readonly IHit[],
  range: IRange
): Interaction.IShare<TKind>[] => {
  const first = addDays(startOfWeek(range.to - 1), -7 * (queries.TREND_WEEKS - 1))
  const weeks = Array.from({ length: queries.TREND_WEEKS }, (_, index) => addDays(first, 7 * index))

  return kinds.map((kind) => {
    const ofKind = hits.filter((hit) => hit.kind === kind)
    return {
      kind,
      count: ofKind.filter((hit) => isWithin(hit.at, range.from, range.to)).length,
      weekly: weeks.map((start) => {
        const end = addDays(start, 7)
        const total = records.filter((at) => isWithin(at, start, end)).length
        return total === 0 ? 0 : ofKind.filter((hit) => isWithin(hit.at, start, end)).length / total
      }),
    }
  })
}

// The prompts a labelling gave an `act`, and the reactions of each kind they hold, once per prompt.
const labelledPrompts = (): { at: number; reactions: string[] }[] =>
  stepsOf(demo).flatMap((placed) =>
    placed.step.kind === 'prompt' && plannedLabel(demo, placed.step.key, 'act') !== null
      ? [{ at: placed.step.at, reactions: [...new Set(reactionsOf(demo, placed.step.key))] }]
      : []
  )

// The replies a labelling gave codes, with the model that wrote them.
const labelledReplies = (): { at: number; model: string; codes: string[] }[] =>
  stepsOf(demo).flatMap((placed) => {
    if (placed.step.kind !== 'reply') {
      return []
    }
    const codes = plannedLabel(demo, placed.step.key, 'reply')
    return codes === null ? [] : [{ at: placed.step.at, model: placed.step.model, codes: codes.split(',') }]
  })

const agentReactionsOf = (range: IRange): ReturnType<typeof queries.agentReactions> =>
  [...Map.groupBy(labelledReplies(), (reply) => reply.model)]
    .map(([model, ofModel]) => ({
      model,
      replies: ofModel.filter((reply) => reply.at >= range.from && reply.at < range.to).length,
      reactions: sharesOf(
        queries.REPLY_HABITS,
        ofModel.map((reply) => reply.at),
        ofModel.flatMap((reply) => reply.codes.map((kind) => ({ at: reply.at, kind }))),
        range
      ),
    }))
    .filter((model) => model.replies > 0)
    .toSorted((left, right) =>
      right.replies === left.replies ? left.model.localeCompare(right.model) : right.replies - left.replies
    )

const reactionTrendOf = (range: IRange): ReturnType<typeof queries.reactionTrend> => {
  const prompts = labelledPrompts()
  return {
    prompts: prompts.filter((prompt) => prompt.at >= range.from && prompt.at < range.to).length,
    reactions: sharesOf(
      queries.TREND_REACTIONS,
      prompts.map((prompt) => prompt.at),
      prompts.flatMap((prompt) => prompt.reactions.map((kind) => ({ at: prompt.at, kind }))),
      range
    ),
  }
}

describe('agentReactions', () => {
  it("should give each model's share of replies with each code in the range and by week, from the newest labelling of each reply", () => {
    const range = rangeOf('range=all', demo.plan.plan.anchor)
    const expected = agentReactionsOf(range)

    expect({
      reactions: queries.agentReactions(range),
      models: expected.length,
      isAnyCode: expected.some((model) => model.reactions.some((reaction) => reaction.count > 0)),
    }).toEqual({
      reactions: expected,
      models: new Set(labelledReplies().map((reply) => reply.model)).size,
      isAnyCode: true,
    })
  })

  it('should leave out a model with no replies in the range', () => {
    expect(queries.agentReactions(laterDay())).toEqual([])
  })
})

describe('reactionTrend', () => {
  it("should give each kind's share of the labelled prompts in the range and of each of the weeks up to its end", () => {
    const range = rangeOf('range=all', demo.plan.plan.anchor)
    const expected = reactionTrendOf(range)

    expect({
      trend: queries.reactionTrend(range),
      isEachKind: expected.reactions.every((reaction) => reaction.count > 0),
    }).toEqual({ trend: expected, isEachKind: true })
  })

  it('should keep the weeks before a range that starts after the reactions', () => {
    const expected = reactionTrendOf(laterDay())

    expect({
      trend: queries.reactionTrend(laterDay()),
      isAnyWeek: expected.reactions.some((reaction) => reaction.weekly.some((share) => share > 0)),
    }).toEqual({ trend: { ...expected, prompts: 0 }, isAnyWeek: true })
  })
})
