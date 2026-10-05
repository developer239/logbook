import { oneInTen, typical } from '../format'
import { countStartedBy, NOT_WORK, type StartedBy } from '../labels'
import { sum, sumBy } from '../lists'
import type { IRange } from '../range'
import { activeMsOf, modelLabel, startedBy, tokensRead } from '../sql'
import { MINUTE } from '../time'
import { all } from '../warehouse'

interface ISessionEffort {
  id: string
  startedBy: StartedBy
  goal: string | null
  read: number | null
  peak: number | null
}

const sessionEfforts = (range: IRange): ISessionEffort[] =>
  all<ISessionEffort>(
    `SELECT s.id, ${startedBy('s')} AS startedBy, ${modelLabel('session', 's.id', 'goal')} AS goal,
       (SELECT SUM(${tokensRead('m')}) FROM message m WHERE m.session_id = s.id AND m.actor = 'assistant') AS read,
       (SELECT MAX(${tokensRead('m')}) FROM message m WHERE m.session_id = s.id AND m.actor = 'assistant') AS peak
     FROM session s WHERE s.started_at >= ? AND s.started_at < ?`,
    range.from,
    range.to
  )

const isWork = (goal: string | null): goal is string => goal !== null && !NOT_WORK.has(goal)

const byWorkGoal = <TItem extends { goal: string | null }>(items: readonly TItem[]): Map<string, TItem[]> =>
  new Map(
    [...Map.groupBy(items, (item) => item.goal)].flatMap(([goal, ofGoal]): [string, TItem[]][] =>
      isWork(goal) ? [[goal, ofGoal]] : []
    )
  )

const CONVERSATION_GOAL_MIN = 3

const byGoalRows = <TItem extends { goal: string | null }, TRow>(
  items: readonly TItem[],
  min: number,
  rowOf: (goal: string, ofGoal: TItem[]) => TRow
): TRow[] =>
  [...byWorkGoal(items)]
    .filter(([, ofGoal]) => ofGoal.length >= min)
    .toSorted((left, right) => right[1].length - left[1].length)
    .map(([goal, ofGoal]) => rowOf(goal, ofGoal))

export interface IGoalMix {
  goal: string
  by: Record<StartedBy, number>
}

export const goalTotal = (goal: IGoalMix): number => sum(Object.values(goal.by))

export const goalMix = (range: IRange): { goals: IGoalMix[]; notWork: number; unlabelled: number } => {
  const sessions = sessionEfforts(range)
  const goals = [...byWorkGoal(sessions)].map(([goal, ofGoal]): IGoalMix => ({ goal, by: countStartedBy(ofGoal) }))

  return {
    goals: goals.toSorted((left, right) => goalTotal(right) - goalTotal(left)),
    notWork: sessions.filter((session) => session.goal !== null && NOT_WORK.has(session.goal)).length,
    unlabelled: sessions.filter((session) => session.goal === null).length,
  }
}

export interface IGoalTokens {
  goal: string
  conversations: number
  read: number
  context: number
}

export const tokensByGoal = (
  range: IRange
): { rows: IGoalTokens[]; measuredConversations: number; workConversations: number } => {
  const sessions = sessionEfforts(range)
  const withTokens = sessions.filter((session) => session.read !== null && session.read > 0)

  const rows = byGoalRows(withTokens, CONVERSATION_GOAL_MIN, (goal, ofGoal): IGoalTokens => ({
    goal,
    conversations: ofGoal.length,
    read: typical(ofGoal.map((session) => session.read ?? 0)),
    context: typical(ofGoal.map((session) => session.peak ?? 0)),
  }))

  return {
    rows: rows.toSorted((left, right) => right.read - left.read),
    measuredConversations: withTokens.filter((session) => isWork(session.goal)).length,
    workConversations: sessions.filter((session) => isWork(session.goal)).length,
  }
}

export interface ITurnWait {
  goal: string | null
  turns: number
  typicalMs: number
  oneInTenMs: number | null
}

export const ONE_IN_TEN_MIN_TURNS = 20

const TURN_GOAL_MIN = 5

export const LONG_TURN_MS = 20 * MINUTE

export const timePerTurn = (range: IRange): { rows: ITurnWait[]; prompts: number; longWaitShare: number | null } => {
  const turns = all<{ goal: string | null; wall: number; idle: number; human: number }>(
    `SELECT ${modelLabel('session', 't.session_id', 'goal')} AS goal, t.ended_at - t.started_at AS wall,
       t.idle_ms AS idle, t.human_wait_ms AS human
     FROM turn t JOIN session s ON s.id = t.session_id
     WHERE s.origin = 'interactive' AND t.is_prompt = 1 AND t.requests > 0 AND t.started_at >= ? AND t.started_at < ?`,
    range.from,
    range.to
  ).map((turn) => ({ ...turn, wait: turn.wall - turn.human }))

  const row = (goal: string | null, ofGoal: typeof turns): ITurnWait => ({
    goal,
    turns: ofGoal.length,
    typicalMs: typical(ofGoal.map((turn) => turn.wait)),
    oneInTenMs: ofGoal.length < ONE_IN_TEN_MIN_TURNS ? null : oneInTen(ofGoal.map((turn) => turn.wait)),
  })

  const long = turns.filter((turn) => turn.wait > LONG_TURN_MS)

  return {
    rows: [row(null, turns), ...byGoalRows(turns, TURN_GOAL_MIN, row)],
    prompts: turns.length,
    // human_wait_ms is by definition a part of idle_ms, so idle less human is
    // never negative and the share needs no clamping.
    longWaitShare:
      long.length === 0 ? null : sumBy(long, (turn) => turn.idle - turn.human) / sumBy(long, (turn) => turn.wait),
  }
}

export interface IConversationTime {
  goal: string | null
  conversations: number
  activeMs: number
  elapsedMs: number
}

export const timePerConversation = (range: IRange): { rows: IConversationTime[]; conversations: number } => {
  const sessions = all<{ goal: string | null; activeMs: number; elapsedMs: number }>(
    `SELECT * FROM (
       SELECT ${modelLabel('session', 's.id', 'goal')} AS goal,
         ${activeMsOf('s')} AS activeMs,
         COALESCE(s.ended_at, (SELECT MAX(m.created_at) FROM message m WHERE m.session_id = s.id), s.started_at)
           - s.started_at AS elapsedMs
       FROM session s WHERE s.origin = 'interactive' AND s.started_at >= ? AND s.started_at < ?
     ) WHERE activeMs > 0`,
    range.from,
    range.to
  )

  const row = (goal: string | null, ofGoal: typeof sessions): IConversationTime => ({
    goal,
    conversations: ofGoal.length,
    activeMs: typical(ofGoal.map((session) => session.activeMs)),
    elapsedMs: typical(ofGoal.map((session) => session.elapsedMs)),
  })

  return {
    rows: sessions.length === 0 ? [] : [row(null, sessions), ...byGoalRows(sessions, CONVERSATION_GOAL_MIN, row)],
    conversations: sessions.length,
  }
}
