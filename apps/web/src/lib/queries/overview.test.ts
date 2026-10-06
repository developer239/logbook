import type { IBuiltDemo } from '@log-book/demo'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import {
  allTime,
  callRowsOf,
  callsOf,
  failedCallsOf,
  familyOf,
  idOf,
  isFailed,
  isRealResult,
  plannedLabel,
  startedByOf,
  stepsOf,
  titleOf,
  type IFailedCall,
  type TPlannedSession,
} from '../../../test/plan-facts'
import { tokensOf } from '../context'
import { oneInTen, typical } from '../format'
import { causeOf, countStartedBy, DIDNT_FINISH, NOT_WORK } from '../labels'
import { copyDemo, insert, type ITestWarehouse } from '../testing/warehouse'
import { addDays, startOfDay } from '../time'
import type * as Effort from './effort'
import type * as Loops from './loops'
import type * as Problems from './problems'
import type * as Strip from './strip'
import type * as ToolTokens from './tool-tokens'
import type * as Unfinished from './unfinished'

let demo: IBuiltDemo
let warehouse: ITestWarehouse
let strip: typeof Strip
let unfinished: typeof Unfinished
let loops: typeof Loops
let problems: typeof Problems
let effort: typeof Effort
let toolTokens: typeof ToolTokens

// Odd rows on top of the copy: the MCP tool's definition loaded under the name its calls were recorded with, as Claude
// Code records a deferred tool (the small set loads it by its bare name), and a call of a tool of that name under a
// server that loaded none.
const DEFINITION_CHARS = 400
const OTHER_SERVER_CALL = 'other-server-call'
const OTHER_SERVER = 'notes'

const mcpCall = (): ReturnType<typeof callsOf>[number] => {
  const call = callsOf(demo).find((placed) => placed.step.family === 'mcp')
  if (call === undefined) {
    throw new Error('The small set plans no MCP call')
  }
  return call
}

beforeAll(async () => {
  demo = inject('demoSmall')
  warehouse = await copyDemo('demoSmall')
  const mcp = mcpCall()
  const row = warehouse.db
    .prepare('SELECT session_id, message_id, name, bare_name, server, started_at FROM tool_call WHERE id = ?')
    .get(idOf(demo, mcp.step.key)) as {
    session_id: string
    message_id: string
    name: string
    bare_name: string
    server: string
    started_at: number
  }
  insert(warehouse.db, 'event', {
    id: 'loaded-definition',
    session_id: row.session_id,
    kind: 'tools-loaded',
    at: row.started_at,
    data_json: JSON.stringify({ tools: [{ name: row.name, chars: DEFINITION_CHARS }] }),
  })
  insert(warehouse.db, 'tool_call', {
    id: OTHER_SERVER_CALL,
    session_id: row.session_id,
    message_id: row.message_id,
    name: row.name.replace(row.server, OTHER_SERVER),
    bare_name: row.bare_name,
    server: OTHER_SERVER,
    family: `mcp:${OTHER_SERVER}`,
    input_json: '{}',
    status: 'completed',
    started_at: row.started_at,
    ended_at: row.started_at,
  })
  strip = await import('./strip')
  unfinished = await import('./unfinished')
  loops = await import('./loops')
  problems = await import('./problems')
  effort = await import('./effort')
  toolTokens = await import('./tool-tokens')
})

afterAll(async () => {
  await warehouse.remove()
})

const sessions = (): TPlannedSession[] => demo.plan.plan.sessions

// The name a call was recorded under, without its server's prefix: the adapter's, which no plan spells.
const recordedName = (id: string): string =>
  (warehouse.db.prepare('SELECT bare_name FROM tool_call WHERE id = ?').get(id) as { bare_name: string }).bare_name

// The active time of the turns the engine derived for the sessions given, as the sync wrote them.
const activeMsOf = (keys: readonly string[]): number =>
  keys
    .map(
      (key) =>
        warehouse.db
          .prepare('SELECT COALESCE(SUM(model_ms + tool_ms), 0) AS ms FROM turn WHERE session_id = ?')
          .get(idOf(demo, key)) as { ms: number }
    )
    .reduce((total, row) => total + row.ms, 0)

// When each call happened: the planned ones and the odd one this file adds.
const callTimes = (): number[] => [...callRowsOf(demo).map((placed) => placed.step.startAt), mcpCall().step.startAt]

const goalOf = (session: TPlannedSession): string | null => plannedLabel(demo, session.key, 'goal')

// The failed calls that were a problem, by cause as shown.
const problemCauses = (): Map<string, IFailedCall[]> =>
  Map.groupBy(
    failedCallsOf(demo).filter((call) => !isRealResult(call)),
    (call) => causeOf(call.family, call.label) ?? ''
  )

const isWork = (goal: string | null): goal is string => goal !== null && !NOT_WORK.has(goal)

describe('stripFor', () => {
  it('should total the range: conversations by starter, work time, calls and failures', () => {
    const failed = failedCallsOf(demo)

    const { current, previous } = strip.stripFor(allTime(demo))

    expect({ current, previous }).toStrictEqual({
      current: {
        conversations: sessions().length,
        by: countStartedBy(sessions().map((session) => ({ startedBy: startedByOf(session) }))),
        activeMs: activeMsOf(sessions().map((session) => session.key)),
        done: sessions().filter((session) => plannedLabel(demo, session.key, 'outcome') === 'done').length,
        calls: callTimes().length,
        failed: failed.length,
        realResults: failed.filter(isRealResult).length,
      },
      previous: null,
    })
  })

  it('should total the range before it for a range that has one', () => {
    // Split at the start of the middle conversation.
    const starts = sessions()
      .map((session) => session.start)
      .toSorted((left, right) => left - right)
    const split = starts[Math.floor(starts.length / 2)] ?? 0
    const range = { ...allTime(demo), from: split, previous: { from: 0, to: split } }
    const isBefore = (at: number): boolean => at < split

    const { current, previous } = strip.stripFor(range)

    expect({ current, previous }).toMatchObject({
      current: {
        conversations: sessions().filter((session) => !isBefore(session.start)).length,
        calls: callTimes().filter((at) => !isBefore(at)).length,
      },
      previous: {
        conversations: sessions().filter((session) => isBefore(session.start)).length,
        calls: callTimes().filter(isBefore).length,
        failed: failedCallsOf(demo).filter((call) => isBefore(call.step.startAt)).length,
      },
    })
  })
})

describe('unfinished', () => {
  it('should list the conversations that did not finish, and how many the range has', () => {
    const didntFinish: readonly string[] = DIDNT_FINISH
    const expected = sessions()
      .flatMap((session) => {
        const outcome = plannedLabel(demo, session.key, 'outcome')
        return outcome !== null && didntFinish.includes(outcome) ? [{ session, outcome }] : []
      })
      .toSorted((left, right) => right.session.end - left.session.end)
      .map(({ session, outcome }) => ({
        sessionId: idOf(demo, session.key),
        outcome,
        note: plannedLabel(demo, session.key, 'outcomeNote'),
        title: titleOf(demo, session.key),
        at: session.end,
      }))

    expect({ ...unfinished.unfinished(allTime(demo)), isAny: expected.length > 0 }).toStrictEqual({
      rows: expected,
      conversationTotal: sessions().length,
      isAny: true,
    })
  })
})

describe('retryLoops', () => {
  it('should find a tool called with the same input again and again, failing', () => {
    // The prompt turn a call is in: the last prompt of its session before it.
    const turnOf = (sessionKey: string, callKey: string): string | null => {
      const steps = stepsOf(demo).filter((placed) => placed.sessionKey === sessionKey)
      const prompt = steps
        .slice(
          0,
          steps.findIndex((placed) => placed.step.key === callKey)
        )
        .findLast((placed) => placed.step.kind === 'prompt')
      return prompt === undefined ? null : idOf(demo, prompt.step.key)
    }
    const expected = Map.groupBy(
      callsOf(demo),
      (placed) =>
        `${placed.sessionKey} ${familyOf(placed.step)} ${placed.step.tool ?? ''} ${JSON.stringify(placed.step.input)}`
    )
      .values()
      .toArray()
      .filter((calls) => calls.length >= 3 && calls.filter((placed) => isFailed(placed.step)).length >= 2)
      .map((calls) => {
        const [first] = calls
        const last = calls.at(-1)
        if (first === undefined || last === undefined) {
          throw new Error('A loop has no call')
        }
        const firstCallId = idOf(demo, first.step.key)
        const { input_json: input } = warehouse.db
          .prepare('SELECT input_json FROM tool_call WHERE id = ?')
          .get(firstCallId) as { input_json: string }
        return {
          sessionId: idOf(demo, first.sessionKey),
          title: titleOf(demo, first.sessionKey),
          name: recordedName(firstCallId),
          input,
          tries: calls.length,
          failed: calls.filter((placed) => isFailed(placed.step)).length,
          firstCallId,
          turnId: turnOf(first.sessionKey, first.step.key),
          spanMs: last.step.startAt - first.step.startAt,
        }
      })

    expect({ ...loops.retryLoops(allTime(demo)), isAny: expected.length > 0 }).toStrictEqual({
      loops: expected,
      tries: expected.reduce((total, loop) => total + loop.tries, 0),
      byTool: [...Map.groupBy(expected, (loop) => loop.name)].map(([name, ofName]) => ({ name, loops: ofName.length })),
      isAny: true,
    })
  })
})

describe('toolProblems', () => {
  it('should group the failures that were a problem by cause as shown, the commonest first', () => {
    const failed = failedCallsOf(demo)

    const { causes, ...counts } = problems.toolProblems(allTime(demo))

    expect({
      causes: causes
        .map((cause) => [cause.cause, cause.calls, cause.roseFrom])
        .toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))),
      isCommonestFirst: causes.every((cause, index) => index === 0 || (causes[index - 1]?.calls ?? 0) >= cause.calls),
      counts,
    }).toStrictEqual({
      causes: [...problemCauses()]
        .map(([cause, calls]) => [cause, calls.length, null])
        .toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))),
      isCommonestFirst: true,
      counts: {
        failed: failed.filter((call) => !isRealResult(call)).length,
        realResults: failed.filter(isRealResult).length,
      },
    })
  })

  it('should name up to three tools of each cause, each one a tool that failed of it', () => {
    const { causes } = problems.toolProblems(allTime(demo))

    expect(
      causes.map((cause) => {
        const names = new Set(
          (problemCauses().get(cause.cause) ?? []).map((call) => recordedName(call.id).toLowerCase())
        )
        return {
          isEach: cause.tools.every((tool) => names.has(tool.toLowerCase())),
          count: cause.tools.length,
        }
      })
    ).toStrictEqual(
      causes.map((cause) => ({
        isEach: true,
        count: Math.min(
          3,
          new Set((problemCauses().get(cause.cause) ?? []).map((call) => recordedName(call.id).toLowerCase())).size
        ),
      }))
    )
  })

  it('should count the failures of the last seven days by day', () => {
    const range = allTime(demo)
    const lastDay = startOfDay(Math.min(range.to - 1, Date.now()))
    const dayStarts = Array.from({ length: 7 }, (_, index) => addDays(lastDay, index - 6))
    const end = addDays(lastDay, 1)

    const { causes } = problems.toolProblems(range)

    expect(causes.map((cause) => [cause.cause, cause.dailyFailures])).toStrictEqual(
      causes.map((cause) => [
        cause.cause,
        dayStarts.map((start, index) => {
          const next = dayStarts[index + 1] ?? end
          return (problemCauses().get(cause.cause) ?? []).filter(
            (call) => call.step.startAt >= start && call.step.startAt < next
          ).length
        }),
      ])
    )
  })
})

describe('effort', () => {
  it('should count conversations by kind of work and by who started them', () => {
    const { goals, notWork, unlabelled } = effort.goalMix(allTime(demo))

    expect({
      goals: goals.toSorted((left, right) => left.goal.localeCompare(right.goal)),
      notWork,
      unlabelled,
    }).toStrictEqual({
      goals: [...Map.groupBy(sessions(), goalOf)]
        .flatMap(([goal, ofGoal]) =>
          isWork(goal)
            ? [{ goal, by: countStartedBy(ofGoal.map((session) => ({ startedBy: startedByOf(session) }))) }]
            : []
        )
        .toSorted((left, right) => left.goal.localeCompare(right.goal)),
      notWork: sessions().filter((session) => {
        const goal = goalOf(session)
        return goal !== null && NOT_WORK.has(goal)
      }).length,
      unlabelled: sessions().filter((session) => goalOf(session) === null).length,
    })
  })

  it('should show a goal its typical tokens only where it has enough measured conversations', () => {
    // The tokens each reply read: its input, cache reads and cache writes.
    const readOf = (session: TPlannedSession): number[] =>
      stepsOf(demo).flatMap((placed) =>
        placed.sessionKey === session.key && placed.step.kind === 'reply' && placed.step.tokens !== null
          ? [
              (placed.step.tokens.input ?? 0) +
                (placed.step.tokens.cacheRead ?? 0) +
                (placed.step.tokens.cacheWrite ?? 0),
            ]
          : []
      )
    const measured = sessions().filter((session) => readOf(session).reduce((total, read) => total + read, 0) > 0)
    const rows = [...Map.groupBy(measured, goalOf)]
      .flatMap(([goal, ofGoal]) => (isWork(goal) && ofGoal.length >= 3 ? [{ goal, ofGoal }] : []))
      .map(({ goal, ofGoal }) => ({
        goal,
        conversations: ofGoal.length,
        read: typical(ofGoal.map((session) => readOf(session).reduce((total, read) => total + read, 0))),
        context: typical(ofGoal.map((session) => Math.max(...readOf(session)))),
      }))

    const tokens = effort.tokensByGoal(allTime(demo))

    expect({
      ...tokens,
      rows: tokens.rows.toSorted((left, right) => left.goal.localeCompare(right.goal)),
    }).toStrictEqual({
      rows: rows.toSorted((left, right) => left.goal.localeCompare(right.goal)),
      measuredConversations: measured.filter((session) => isWork(goalOf(session))).length,
      workConversations: sessions().filter((session) => isWork(goalOf(session))).length,
    })
  })

  it('should time the turns I typed without the time spent waiting on my answers', () => {
    // The engine derives a turn's times; the plan holds none of them.
    const waits = (
      warehouse.db
        .prepare(
          `SELECT t.ended_at - t.started_at - t.human_wait_ms AS wait FROM turn t JOIN session s ON s.id = t.session_id
           WHERE s.origin = 'interactive' AND t.is_prompt = 1 AND t.requests > 0`
        )
        .all() as { wait: number }[]
    ).map((turn) => turn.wait)

    const { rows, prompts } = effort.timePerTurn(allTime(demo))

    expect({ prompts, all: rows[0] }).toStrictEqual({
      prompts: waits.length,
      all: {
        goal: null,
        turns: waits.length,
        typicalMs: typical(waits),
        oneInTenMs: waits.length < effort.ONE_IN_TEN_MIN_TURNS ? null : oneInTen(waits),
      },
    })
  })

  it('should time the conversations I started: how long the agent worked, and how long they ran', () => {
    const mine = sessions().filter((session) => session.origin === 'interactive' && activeMsOf([session.key]) > 0)

    const { rows, conversations } = effort.timePerConversation(allTime(demo))

    expect({ all: rows[0], conversations }).toStrictEqual({
      all: {
        goal: null,
        conversations: mine.length,
        activeMs: typical(mine.map((session) => activeMsOf([session.key]))),
        elapsedMs: typical(mine.map((session) => session.end - session.start)),
      },
      conversations: mine.length,
    })
  })
})

describe('toolTokens', () => {
  it('should estimate what an MCP tool costs under its recorded server, with the definition a session loaded', () => {
    const mcp = mcpCall()

    const tool = toolTokens.toolTokens(allTime(demo)).find((row) => row.source.name === mcp.step.server)

    expect(tool).toMatchObject({
      name: recordedName(idOf(demo, mcp.step.key)),
      source: { kind: 'plugin', name: mcp.step.server },
      calls: callsOf(demo).filter((placed) => placed.step.server === mcp.step.server).length,
      definitionTokens: tokensOf(DEFINITION_CHARS),
    })
  })

  it('should not take a tool of another server for the one it is named like', () => {
    const other = toolTokens.toolTokens(allTime(demo)).find((row) => row.source.name === OTHER_SERVER)

    expect(other).toMatchObject({ name: recordedName(OTHER_SERVER_CALL), calls: 1, definitionTokens: null })
  })

  it('should count a skill by the text its load put in the context, as its harness recorded the load', () => {
    const skills = stepsOf(demo).flatMap((placed) => (placed.step.kind === 'skill' ? [placed.step] : []))
    const loadedChars = (key: string): number =>
      (
        warehouse.db
          .prepare(
            "SELECT json_extract(data_json, '$.chars') AS chars FROM event WHERE kind = 'skill-loaded' AND json_extract(data_json, '$.toolCallId') = ?"
          )
          .get(idOf(demo, key)) as { chars: number }
      ).chars

    const rows = toolTokens.toolTokens(allTime(demo)).filter((row) => row.source.kind === 'skills')

    expect(rows.toSorted((left, right) => left.name.localeCompare(right.name))).toMatchObject(
      skills
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .map((skill) => ({
          name: skill.name,
          calls: 1,
          typicalTokens: tokensOf(loadedChars(skill.key)),
          definitionTokens: null,
        }))
    )
  })
})
