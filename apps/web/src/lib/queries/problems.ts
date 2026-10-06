import { causeOf, UNLABELLED } from '../labels'
import { countBy } from '../lists'
import type { IRange } from '../range'
import { addDays, startOfDay } from '../time'
import { causeCounts, failedCalls } from './calls'

interface ICause {
  cause: string
  calls: number
  dailyFailures: number[]
  roseFrom: number | null
  tools: string[]
}

export interface IToolProblems {
  causes: ICause[]
  failed: number
  realResults: number
}

const ROSE_FACTOR = 2
const ROSE_MIN_INCREASE = 5

const roseFrom = (current: number, previous: number): number | null =>
  current >= ROSE_FACTOR * previous && current - previous >= ROSE_MIN_INCREASE ? previous : null

// The harnesses call the shell Bash and bash, so a name counts whatever its case.
const topNames = (names: readonly string[], take: number): string[] =>
  [...Map.groupBy(names, (name) => name.toLowerCase()).values()]
    .toSorted((left, right) => right.length - left.length)
    .slice(0, take)
    .flatMap((group) => group.slice(0, 1))

const WEEK_DAYS = 7
const TOP_TOOLS = 3

export const toolProblems = (range: IRange): IToolProblems => {
  const calls = failedCalls(range.from, range.to)
  const lastDay = startOfDay(Math.min(range.to - 1, Date.now()))

  const dayStart = (back: number): number => addDays(lastDay, -back)
  const dayStarts = Array.from({ length: WEEK_DAYS }, (_, index) => dayStart(WEEK_DAYS - 1 - index))

  // The seven days are read on their own, so a range shorter than a week does
  // not draw the days before it as quiet.
  const weekCalls = failedCalls(dayStart(WEEK_DAYS - 1), dayStart(-1))

  const previous =
    range.previous === null ? new Map<string, number>() : causeCounts(range.previous.from, range.previous.to)

  const caused = calls.flatMap((call) => {
    const cause = causeOf(call.family, call.label)
    return cause === null ? [] : [{ call, cause }]
  })
  const realResults = calls.length - caused.length

  const byCause = new Map(
    [...Map.groupBy(caused, (entry) => entry.cause)].map(([cause, entries]) => [
      cause,
      entries.map((entry) => entry.call),
    ])
  )

  const weekByCause = Map.groupBy(weekCalls, (call) => causeOf(call.family, call.label))
  const causes = [...byCause.entries()]
    .map(([cause, ofCause]): ICause => {
      const perDay = countBy(weekByCause.get(cause) ?? [], (call) =>
        dayStarts.findLastIndex((start) => call.at >= start)
      )

      return {
        cause,
        calls: ofCause.length,
        dailyFailures: dayStarts.map((_, index) => perDay.get(index) ?? 0),
        roseFrom:
          range.previous === null || cause === UNLABELLED ? null : roseFrom(ofCause.length, previous.get(cause) ?? 0),
        tools: topNames(
          ofCause.map((call) => call.name),
          TOP_TOOLS
        ),
      }
    })
    .toSorted((left, right) => right.calls - left.calls)

  return { causes, failed: calls.length - realResults, realResults }
}
