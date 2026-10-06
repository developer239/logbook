import type { IBuiltDemo } from '@log-book/demo'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import {
  allTime,
  callsOf,
  failedCallsOf,
  familyOf,
  firstPromptOf,
  harnessOf,
  idOf,
  isFailed,
  ownStepsOf,
  plannedLabel,
  plannedSession,
  promptBefore,
  reactionsOf,
  scriptOf,
  sessionWith,
  startedByOf,
  titleOf,
  type TPlannedSession,
  type TStep,
} from '../../../test/plan-facts'
import { parseFilter } from '../filter'
import { causeOf } from '../labels'
import { copyDemo, type ITestWarehouse } from '../testing/warehouse'
import type * as Conversation from './conversation'
import type * as Conversations from './conversations'
import type * as HarnessQueries from './harnesses'

let demo: IBuiltDemo
let warehouse: ITestWarehouse
let list: typeof Conversations
let one: typeof Conversation
let harnesses: typeof HarnessQueries

beforeAll(async () => {
  demo = inject('demoSmall')
  warehouse = await copyDemo('demoSmall')
  list = await import('./conversations')
  one = await import('./conversation')
  harnesses = await import('./harnesses')
})

afterAll(async () => {
  await warehouse.remove()
})

type TSpawnStep = Extract<TStep, { kind: 'spawn' }>

const sessions = (): TPlannedSession[] => demo.plan.plan.sessions

const listed = (query: string, page = 0): ReturnType<typeof Conversations.conversations> =>
  list.conversations(parseFilter(query), allTime(demo), page, harnesses.harnessesOf())

const idsOf = (query: string): string[] =>
  listed(query)
    .rows.map((row) => row.id)
    .toSorted()

const idsWhere = (isWanted: (session: TPlannedSession) => boolean): string[] =>
  sessions()
    .filter(isWanted)
    .map((session) => idOf(demo, session.key))
    .toSorted()

const isSpawn = (step: TStep): step is TSpawnStep => step.kind === 'spawn'

// A spawn whose call recorded the session it started, which places that session under a turn.
const isLinkedSpawn = (step: TStep): boolean =>
  isSpawn(step) &&
  (
    warehouse.db.prepare('SELECT child_session_id FROM tool_call WHERE id = ?').get(idOf(demo, step.key)) as
      | { child_session_id: string | null }
      | undefined
  )?.child_session_id !== null

const spawning = (): string => sessionWith(demo, isLinkedSpawn)

const spawnOf = (key: string): TSpawnStep => {
  const spawn = ownStepsOf(demo, key).filter(isSpawn).find(isLinkedSpawn)
  if (spawn === undefined) {
    throw new Error(`${key} plans no spawn`)
  }
  return spawn
}

// The engine derives a session's active time from its turns; the plan holds none of it.
const activeMsOf = (key: string): number =>
  (
    warehouse.db
      .prepare('SELECT COALESCE(SUM(model_ms + tool_ms), 0) AS ms FROM turn WHERE session_id = ?')
      .get(idOf(demo, key)) as { ms: number }
  ).ms

// What the agent did: each reply and each call.
const stepCountOf = (key: string): number =>
  ownStepsOf(demo, key).filter((step) => ['reply', 'call', 'spawn', 'skill'].includes(step.kind)).length

const failedOf = (key: string): number =>
  ownStepsOf(demo, key).filter((step) => step.kind === 'call' && isFailed(step)).length

// The steps a message records; a reply's is written when it is done.
const MESSAGE_KINDS: ReadonlySet<string> = new Set(['prompt', 'command', 'interrupt'])

// When the last message was written.
const lastAtOf = (key: string): number =>
  Math.max(
    ...ownStepsOf(demo, key).flatMap((step) => {
      if (step.kind === 'reply') {
        return [step.endAt]
      }
      return MESSAGE_KINDS.has(step.kind) && 'at' in step ? [step.at] : []
    })
  )

const byId = (left: (string | null)[], right: (string | null)[]): number =>
  String(left[0]).localeCompare(String(right[0]))

// A session that called one tool with one input three times or more, failing at least twice.
const isRetried = (key: string): boolean =>
  [
    ...Map.groupBy(
      callsOf(demo).filter((placed) => placed.sessionKey === key),
      (placed) => `${familyOf(placed.step)} ${placed.step.tool ?? ''} ${JSON.stringify(placed.step.input)}`
    ).values(),
  ].some((calls) => calls.length >= 3 && calls.filter((placed) => isFailed(placed.step)).length >= 2)

// Everything a step holds as text: what was said, what a call returned and what was loaded or summarised.
const TEXT_FIELDS: ReadonlySet<string> = new Set(['text', 'reasoning', 'result', 'body', 'arguments'])

const textsOf = (step: TStep): string[] => [
  ...Object.entries(step).flatMap(([field, value]) =>
    TEXT_FIELDS.has(field) && typeof value === 'string' ? [value] : []
  ),
  ...(step.kind === 'event' && step.event.type === 'compaction' ? [step.event.summary] : []),
]

describe('conversations', () => {
  it('should list every conversation of the range, the one worked on last first', () => {
    const { rows, total, pageSize } = listed('')

    expect({ ids: rows.map((row) => row.id), total, pageSize }).toStrictEqual({
      ids: sessions()
        .toSorted((left, right) => lastAtOf(right.key) - lastAtOf(left.key))
        .map((session) => idOf(demo, session.key)),
      total: sessions().length,
      pageSize: 100,
    })
  })

  it('should say what a conversation is: its title, who started it, its work and its labels', () => {
    const key = spawning()
    const planned = plannedSession(demo, key)

    const row = listed('').rows.find((candidate) => candidate.id === idOf(demo, key))

    expect(row).toStrictEqual({
      id: idOf(demo, key),
      title: titleOf(demo, key),
      harness: harnessOf(demo, key),
      agent: planned.agent,
      startedBy: startedByOf(planned),
      startedAt: planned.start,
      lastAt: lastAtOf(key),
      endedAt: planned.end,
      activeMs: activeMsOf(key),
      steps: stepCountOf(key),
      failed: failedOf(key),
      goal: plannedLabel(demo, key, 'goal'),
      outcome: plannedLabel(demo, key, 'outcome'),
    })
  })

  it('should title a conversation by its first typed prompt where it has no title, and say who started it', () => {
    const { rows } = listed('')

    expect({
      rows: rows.map((row) => [row.id, row.title, row.startedBy]).toSorted(byId),
      isAnyUntitled: sessions().some((session) => session.title === null),
    }).toStrictEqual({
      rows: sessions()
        .map((session) => [idOf(demo, session.key), titleOf(demo, session.key), startedByOf(session)])
        .toSorted(byId),
      isAnyUntitled: true,
    })
  })

  it('should keep to the range', () => {
    const from = Math.max(...sessions().map((session) => session.start))

    expect(
      list
        .conversations(parseFilter(''), { ...allTime(demo), from }, 0, harnesses.harnessesOf())
        .rows.map((row) => row.id)
    ).toStrictEqual(idsWhere((session) => session.start >= from))
  })

  it('should filter by the labels of a conversation, the newest label counting', () => {
    const goal = plannedLabel(demo, spawning(), 'goal') ?? ''

    expect({ goal: idsOf(`goal:"${goal}"`), done: idsOf('outcome:done') }).toStrictEqual({
      goal: idsWhere((session) => plannedLabel(demo, session.key, 'goal') === goal),
      done: idsWhere((session) => plannedLabel(demo, session.key, 'outcome') === 'done'),
    })
  })

  it('should filter by who started it, its harness and its project', () => {
    const harness = harnessOf(demo, spawning())
    const { filter_alias: alias } = warehouse.db
      .prepare('SELECT filter_alias FROM harness WHERE id = ?')
      .get(harness) as { filter_alias: string }
    const { project } = plannedSession(demo, spawning())
    const agent = sessions().find((session) => session.agent !== null)?.agent ?? ''

    expect({
      agents: idsOf('by:agent'),
      notAgents: idsOf('by:me,script'),
      harness: idsOf(`harness:${alias}`),
      project: idsOf(`project:${project}`),
      agent: idsOf(`agent:${agent}`),
    }).toStrictEqual({
      agents: idsWhere((session) => startedByOf(session) === 'agent'),
      notAgents: idsWhere((session) => startedByOf(session) !== 'agent'),
      harness: idsWhere((session) => harnessOf(demo, session.key) === harness),
      project: idsWhere((session) => session.project === project),
      agent: idsWhere((session) => session.agent === agent),
    })
  })

  it('should filter by what happened in it', () => {
    expect({
      failures: idsOf('has:failures'),
      retry: idsOf('has:retry'),
      correction: idsOf('has:correction'),
      spawned: idsOf('has:spawned'),
    }).toStrictEqual({
      failures: idsWhere((session) => failedOf(session.key) > 0),
      retry: idsWhere((session) => isRetried(session.key)),
      correction: idsWhere((session) =>
        ownStepsOf(demo, session.key).some(
          (step) => step.kind === 'prompt' && reactionsOf(demo, step.key).includes('correction')
        )
      ),
      spawned: idsWhere((session) => ownStepsOf(demo, session.key).some(isLinkedSpawn)),
    })
  })

  it('should filter by a tool called, a model used and a cause of failure', () => {
    const mcp = callsOf(demo).find((placed) => placed.step.family === 'mcp')
    const models = Map.groupBy(
      sessions().flatMap((session) =>
        ownStepsOf(demo, session.key).flatMap((step) =>
          step.kind === 'reply' ? [{ model: step.model, key: session.key }] : []
        )
      ),
      (reply) => reply.model
    )
    const [rarest] = [...models].toSorted((left, right) => left[1].length - right[1].length)
    const causes = failedCallsOf(demo).map((call) => ({ call, cause: causeOf(call.family, call.label) }))
    const [cause] = causes.flatMap((entry) => (entry.cause === null ? [] : [entry.cause]))

    expect({
      tool: idsOf(`tool:${(mcp?.step.tool ?? '').toUpperCase()}`),
      model: idsOf(`model:${rarest?.[0] ?? ''}`),
      cause: idsOf(`cause:"${cause ?? ''}"`),
      unknown: idsOf('cause:"Made up"'),
    }).toStrictEqual({
      tool: idsWhere((session) => session.key === mcp?.sessionKey),
      model: idsWhere((session) => (rarest?.[1] ?? []).some((reply) => reply.key === session.key)),
      cause: [
        ...new Set(causes.filter((entry) => entry.cause === cause).map((entry) => idOf(demo, entry.call.sessionKey))),
      ].toSorted(),
      unknown: [],
    })
  })

  it('should search the text of a conversation and its title, every word of it', () => {
    const textOf = (key: string): string =>
      [plannedSession(demo, key).title ?? '', ...ownStepsOf(demo, key).flatMap(textsOf)].join('\n')
    const isSaying = (key: string, word: string): boolean => new RegExp(`\\b${word}\\b`, 'iu').test(textOf(key))
    const words = firstPromptOf(demo, spawning())
      .text.split(/\W+/u)
      .toSorted((left, right) => right.length - left.length)
    const [first = '', second = ''] = words

    expect({ one: idsOf(first), both: idsOf(`${first} ${second}`) }).toStrictEqual({
      one: idsWhere((session) => isSaying(session.key, first)),
      both: idsWhere((session) => isSaying(session.key, first) && isSaying(session.key, second)),
    })
  })

  it('should count the whole list for a page past its end', () => {
    const { total, pageSize } = listed('')

    expect(listed('', Math.ceil(total / pageSize))).toMatchObject({ rows: [], total: sessions().length })
  })
})

describe('conversation', () => {
  it('should say what a conversation is and did', () => {
    const key = spawning()
    const planned = plannedSession(demo, key)
    const models = ownStepsOf(demo, key).flatMap((step) => (step.kind === 'reply' ? [step.model] : []))
    const [mainModel] = [...Map.groupBy(models, (model) => model)].toSorted(
      (left, right) => right[1].length - left[1].length
    )

    expect(one.conversation(idOf(demo, key))).toStrictEqual({
      id: idOf(demo, key),
      harness: harnessOf(demo, key),
      startedBy: startedByOf(planned),
      agent: planned.agent,
      title: titleOf(demo, key),
      project: scriptOf(demo, key).projectDir,
      branch: planned.gitBranch,
      model: mainModel?.[0] ?? null,
      startedAt: planned.start,
      endedAt: planned.end,
      activeMs: activeMsOf(key),
      steps: stepCountOf(key),
      failed: failedOf(key),
      spawned: ownStepsOf(demo, key).filter(isLinkedSpawn).length,
      compactions: ownStepsOf(demo, key).filter((step) => step.kind === 'event' && step.event.type === 'compaction')
        .length,
      goal: plannedLabel(demo, key, 'goal'),
      outcome: plannedLabel(demo, key, 'outcome'),
      outcomeNote: plannedLabel(demo, key, 'outcomeNote'),
      parent: null,
    })
  })

  it('should name the turn that started a conversation an agent started', () => {
    const key = spawning()
    const spawn = spawnOf(key)

    expect(one.conversation(idOf(demo, spawn.child.key))).toMatchObject({
      startedBy: 'agent',
      title: titleOf(demo, spawn.child.key),
      parent: {
        sessionId: idOf(demo, key),
        title: titleOf(demo, key),
        turnId: idOf(demo, promptBefore(demo, key, spawn.key)),
      },
    })
  })

  it('should be null where no conversation has the id', () => {
    expect(one.conversation('ses-none')).toBeNull()
  })
})

describe('turnPath', () => {
  it('should lead from a turn up through the agents that started it', () => {
    // The deepest started session, and the turn of each session above it that started the one below.
    const depthOf = (session: TPlannedSession): number =>
      session.parentKey === null ? 0 : 1 + depthOf(plannedSession(demo, session.parentKey))
    const [deepest] = sessions().toSorted((left, right) => depthOf(right) - depthOf(left))
    const pathOf = (key: string, turnKey: string): { id: string; sessionId: string }[] => {
      const { parentKey } = plannedSession(demo, key)
      const step = { id: idOf(demo, turnKey), sessionId: idOf(demo, key) }
      if (parentKey === null) {
        return [step]
      }
      const spawn = ownStepsOf(demo, parentKey)
        .filter(isSpawn)
        .find((candidate) => candidate.child.key === key)
      return [step, ...pathOf(parentKey, promptBefore(demo, parentKey, spawn?.key ?? ''))]
    }
    if (deepest === undefined) {
      throw new Error('The small set plans no session')
    }

    expect({
      path: one.turnPath(idOf(demo, firstPromptOf(demo, deepest.key).key)),
      isNested: depthOf(deepest) > 1,
    }).toStrictEqual({ path: pathOf(deepest.key, firstPromptOf(demo, deepest.key).key), isNested: true })
  })

  it('should be empty for a turn that does not exist', () => {
    expect(one.turnPath('m-none')).toEqual([])
  })
})
