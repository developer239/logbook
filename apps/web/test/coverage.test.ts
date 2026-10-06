import { readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LABEL_TASKS, type IBuiltDemo } from '@log-book/demo'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { parseFilter } from '../src/lib/filter'
import type { IRange } from '../src/lib/range'
import { copyDemo, type ITestWarehouse } from '../src/lib/testing/warehouse'
import { startOfWeek } from '../src/lib/time'
import { allTime } from './plan-facts'
import { renderSet, type IServedPage } from './rendered-pages'

interface IQueryContext {
  range: IRange
  sessionIds: readonly string[]
}

// What each query function of a module returned for range `all`, by its name: rows, or 1 for a state that is there.
type TCounts = Readonly<Record<string, number>>

const QUERIES_DIRECTORY = fileURLToPath(new URL('../src/lib/queries', import.meta.url))
// The fields whose every value the set labels, as the contract names them. A reply's codes are one comma-joined label.
const FULL_FIELDS = ['act', 'reaction', 'about', 'target', 'reach', 'reply', 'outcome', 'purpose', 'failure', 'cause']
const REACTIONS_IN_TWO_WEEKS = ['correction', 'pushback', 'praise']
const CODES_FROM_TWO_MODELS = ['permission', 'caves', 'pushback']
const MAX_PROMPTS_WITHOUT_ACT = 80
const DEFAULT_LABELLER = 'claude-haiku-4-5'
const EMPTY_PANELS = ['class="card__empty"', 'class="first-run"', 'class="labels-missing"']

const sum = (counts: readonly number[]): number => counts.reduce((total, count) => total + count, 0)

// Whether a card draws the share: some week of it is above zero.
const isShown = (weekly: readonly number[]): boolean => weekly.some((share) => share > 0)

// Every module of the queries directory with the functions of it that read the warehouse. A session's queries are
// summed over every session of the set.
const QUERIES: Readonly<Record<string, (context: IQueryContext) => Promise<TCounts>>> = {
  'calls.ts': async ({ range }) => {
    const calls = await import('../src/lib/queries/calls')
    return {
      failedCalls: calls.failedCalls(range.from, range.to).length,
      causeCounts: calls.causeCounts(range.from, range.to).size,
      slowCalls: calls.slowCalls(range).groups.length,
      failuresWithCause: sum(
        [...calls.causeCounts(range.from, range.to).keys()].map((cause) => calls.failuresWithCause(cause))
      ),
    }
  },
  'context-events.ts': async ({ sessionIds }) => {
    const [{ contextEvents }, { sessionCache, sessionOf }] = await Promise.all([
      import('../src/lib/queries/context-events'),
      import('../src/lib/queries/session'),
    ])
    const cache = sessionCache()
    return { contextEvents: sum(sessionIds.map((id) => contextEvents(sessionOf(cache, id)).length)) }
  },
  'conversation.ts': async ({ sessionIds }) => {
    const { conversation, turnPath } = await import('../src/lib/queries/conversation')
    const { sessionCache, sessionOf } = await import('../src/lib/queries/session')
    const cache = sessionCache()
    return {
      conversation: sessionIds.filter((id) => conversation(id) !== null).length,
      turnPath: sum(sessionIds.flatMap((id) => sessionOf(cache, id).turns.map((turn) => turnPath(turn.id).length))),
    }
  },
  'conversations.ts': async ({ range }) => {
    const [{ conversations }, { harnessesOf }] = await Promise.all([
      import('../src/lib/queries/conversations'),
      import('../src/lib/queries/harnesses'),
    ])
    return { conversations: conversations(parseFilter(''), range, 0, harnessesOf()).rows.length }
  },
  'effort.ts': async ({ range }) => {
    const effort = await import('../src/lib/queries/effort')
    return {
      goalMix: effort.goalMix(range).goals.length,
      tokensByGoal: effort.tokensByGoal(range).rows.length,
      timePerTurn: effort.timePerTurn(range).rows.length,
      timePerConversation: effort.timePerConversation(range).rows.length,
    }
  },
  'harnesses.ts': async () => {
    const { harnessesOf } = await import('../src/lib/queries/harnesses')
    return { harnessesOf: harnessesOf().size }
  },
  'interaction.ts': async ({ range }) => {
    const { agentReactions, reactionTrend } = await import('../src/lib/queries/interaction')
    return { reactionTrend: reactionTrend(range).prompts, agentReactions: agentReactions(range).length }
  },
  'labelling.ts': async () => {
    const { hasModelLabelling, labellingState } = await import('../src/lib/queries/labelling')
    const state = labellingState({ run: null, runExit: null, planExit: null, isUpdated: false })
    return { labellingState: state.name === 'never' ? 0 : 1, hasModelLabelling: hasModelLabelling() ? 1 : 0 }
  },
  'loops.ts': async ({ range }) => {
    const { retryLoops } = await import('../src/lib/queries/loops')
    return { retryLoops: retryLoops(range).loops.length }
  },
  'paged.ts': async () => {
    const { allOf, pagedRows } = await import('../src/lib/queries/paged')
    const list = { columns: 's.id', from: 'session s', where: allOf([{ sql: '1 = 1', params: [] }]), order: 's.id' }
    return { pagedRows: pagedRows(list, 0, 10).rows.length }
  },
  'plugins-view.ts': async ({ sessionIds }) => {
    const [{ sessionPlugins }, { sessionCache }] = await Promise.all([
      import('../src/lib/queries/plugins-view'),
      import('../src/lib/queries/session'),
    ])
    const cache = sessionCache()
    return {
      sessionPlugins: sum(
        sessionIds.map((id) => {
          const view = sessionPlugins(cache, id)
          return view.offers === 'recorded' ? view.servers.length : view.plugins.length
        })
      ),
    }
  },
  'problems.ts': async ({ range }) => {
    const { toolProblems } = await import('../src/lib/queries/problems')
    return { toolProblems: toolProblems(range).causes.length }
  },
  'session.ts': async ({ sessionIds }) => {
    const { sessionCache, sessionOf } = await import('../src/lib/queries/session')
    const cache = sessionCache()
    return { sessionOf: sum(sessionIds.map((id) => sessionOf(cache, id).turns.length)) }
  },
  'steps.ts': async ({ range }) => {
    const { parseStepsQuery, steps } = await import('../src/lib/queries/steps')
    return { steps: steps(parseStepsQuery(new URLSearchParams()), range, 0).rows.length }
  },
  'strip.ts': async ({ range }) => {
    const { stripFor } = await import('../src/lib/queries/strip')
    return { stripFor: stripFor(range).current.conversations }
  },
  'thread.ts': async ({ sessionIds }) => {
    const [{ thread }, { sessionCache }] = await Promise.all([
      import('../src/lib/queries/thread'),
      import('../src/lib/queries/session'),
    ])
    const cache = sessionCache()
    return { thread: sum(sessionIds.map((id) => thread(cache, id).turns.length)) }
  },
  'tool-tokens.ts': async ({ range }) => {
    const { toolTokens } = await import('../src/lib/queries/tool-tokens')
    return { toolTokens: toolTokens(range).length }
  },
  'turn.ts': async ({ sessionIds }) => {
    const [{ shownTurn }, { sessionCache, sessionOf }] = await Promise.all([
      import('../src/lib/queries/turn'),
      import('../src/lib/queries/session'),
    ])
    const cache = sessionCache()
    return {
      shownTurn: sum(
        sessionIds.flatMap((id) =>
          sessionOf(cache, id).turns.map((turn) => shownTurn(cache, id, turn.id, null).turn.steps.length)
        )
      ),
    }
  },
  'unfinished.ts': async ({ range }) => {
    const { unfinished } = await import('../src/lib/queries/unfinished')
    return { unfinished: unfinished(range).rows.length }
  },
}

let directory = ''
let demo: IBuiltDemo
let warehouse: ITestWarehouse
let pages: IServedPage[] = []
let variantRuns: unknown

const rows = <TRow>(sql: string, ...params: (string | number)[]): TRow[] =>
  // node:sqlite gives rows without a prototype, which a strict comparison tells apart from plain objects.
  (warehouse.db.prepare(sql).all(...params) as Record<string, unknown>[]).map((row) => ({ ...row }) as TRow)

// The fields of a task's first record type: a record of the task is labelled when one of them is.
const mainFields = (task: (typeof LABEL_TASKS)[number]): string[] =>
  task.fields.filter((field) => field.recordType === task.recordTypes[0]).map((field) => field.name)

// The values of a label name in the set, a reply's codes one by one.
const labelledValues = (name: string): Set<string> =>
  new Set(
    rows<{ value: string }>('SELECT DISTINCT value FROM label WHERE name = ?', name).flatMap(({ value }) =>
      name === 'reply' ? value.split(',') : [value]
    )
  )

// The first human prompt of the session after a time, and whether it has an `act` label.
const promptAfter = (sessionId: string, at: number): { id: string; hasAct: number } | undefined =>
  rows<{ id: string; hasAct: number }>(
    `SELECT m.id, EXISTS (SELECT 1 FROM label l WHERE l.record_type = 'message' AND l.record_id = m.id AND l.name = 'act')
       AS hasAct
     FROM message m WHERE m.session_id = ? AND m.actor = 'user' AND m.created_at > ? ORDER BY m.created_at LIMIT 1`,
    sessionId,
    at
  )[0]

// Pages are rendered first, by a handler over a copy of their own, and the variant is read from a copy removed at
// once; the queries then read the small set's copy, which this file keeps until it ends.
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'web-coverage-'))
  pages = await renderSet('demoSmall', directory)
  const variant = await copyDemo('demoSmallNoLabels')
  variantRuns = { ...(variant.db.prepare('SELECT COUNT(*) AS count FROM label_run').get() as { count: number }) }
  await variant.remove()
  demo = inject('demoSmall')
  warehouse = await copyDemo('demoSmall')
})

afterAll(async () => {
  await warehouse.remove()
  await rm(directory, { recursive: true, force: true })
})

describe("the demo small set's coverage contract", () => {
  it('queries: every module of the queries directory returns rows for range all', async () => {
    // Arrange
    const modules = readdirSync(QUERIES_DIRECTORY).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    const context = {
      range: allTime(demo),
      sessionIds: rows<{ id: string }>('SELECT id FROM session ORDER BY id').map(({ id }) => id),
    }

    // Act
    const counts = await Promise.all(
      Object.entries(QUERIES).map(async ([module, query]) => [module, await query(context)] as const)
    )

    // Assert
    expect({
      unlisted: modules.filter((module) => !(module in QUERIES)),
      empty: counts.flatMap(([module, ofModule]) =>
        Object.entries(ofModule)
          .filter(([, count]) => count === 0)
          .map(([name]) => `${module}: ${name}`)
      ),
    }).toStrictEqual({ unlisted: [], empty: [] })
  })

  it('pages: every page renders with no empty panel, no first-run panel and no "not labelled yet" panel', () => {
    // Act
    const found = pages.flatMap((page) =>
      EMPTY_PANELS.filter((panel) => page.body.includes(panel)).map((panel) => [page.path, panel])
    )

    // Assert
    expect({ statuses: pages.map((page) => page.status), found }).toStrictEqual({
      statuses: pages.map(() => 200),
      found: [],
    })
  })

  it("labels: every value of the contract's fields occurs, and every goal the plan gives its sessions", () => {
    // Arrange
    const fields = LABEL_TASKS.flatMap((task) => task.fields)
    // Specification 08 fixes the small set's labelled sessions at 6 of the goals, so the goals are the plan's.
    const goals = [...new Set(demo.plan.plan.sessions.flatMap((session) => session.goal ?? []))]
    const vocabularyOf = (name: string): readonly string[] => fields.find((field) => field.name === name)?.values ?? []

    // Act
    const missing = [
      ...FULL_FIELDS.flatMap((name) => {
        const labelled = labelledValues(name)
        return vocabularyOf(name)
          .filter((value) => !labelled.has(value))
          .map((value) => `${name}: ${value}`)
      }),
      ...goals.filter((goal) => !labelledValues('goal').has(goal)).map((goal) => `goal: ${goal}`),
    ]

    // Assert
    expect({
      missing,
      vocabularies: FULL_FIELDS.filter((name) => vocabularyOf(name).length === 0),
      isGoalInVocabulary: goals.map((goal) => vocabularyOf('goal').includes(goal)),
    }).toStrictEqual({ missing: [], vocabularies: [], isGoalInVocabulary: goals.map(() => true) })
  })

  it('spread: reactions in two weeks, reply codes from two models, and non-zero shares on both cards', async () => {
    // Arrange
    const range = allTime(demo)
    const reactions = rows<{ value: string; at: number }>(
      `SELECT l.value, m.created_at AS at FROM label l
       JOIN message m ON m.id = substr(l.record_id, 1, instr(l.record_id, '#') - 1)
       WHERE l.record_type = 'reaction' AND l.name = 'reaction'`
    )
    const replies = rows<{ value: string; model: string }>(
      `SELECT l.value, m.model FROM label l JOIN message m ON m.id = l.record_id
       WHERE l.record_type = 'message' AND l.name = 'reply' AND m.model IS NOT NULL`
    )
    const { agentReactions, reactionTrend } = await import('../src/lib/queries/interaction')

    // Act
    const weeks = REACTIONS_IN_TWO_WEEKS.map(
      (kind) => new Set(reactions.filter((row) => row.value === kind).map((row) => startOfWeek(row.at))).size
    )
    const models = CODES_FROM_TWO_MODELS.map(
      (code) => new Set(replies.filter((row) => row.value.split(',').includes(code)).map((row) => row.model)).size
    )
    const trend = reactionTrend(range).reactions.map((share) => isShown(share.weekly))
    const byModel = CODES_FROM_TWO_MODELS.map((code) =>
      agentReactions(range).some((model) =>
        model.reactions.some((share) => share.kind === code && isShown(share.weekly))
      )
    )

    // Assert
    expect({
      weeks: weeks.map((count) => count >= 2),
      models: models.map((count) => count >= 2),
      trend,
      byModel,
    }).toStrictEqual({
      weeks: REACTIONS_IN_TWO_WEEKS.map(() => true),
      models: CODES_FROM_TWO_MODELS.map(() => true),
      trend: trend.map(() => true),
      byModel: CODES_FROM_TWO_MODELS.map(() => true),
    })
  })

  it('events: an interruption and a refusal before labelled prompts, one before an unlabelled prompt, few unlabelled', () => {
    // Arrange
    const events = rows<{ kind: string; sessionId: string; at: number }>(
      `SELECT kind, session_id AS sessionId, at FROM event WHERE kind IN ('interrupted', 'tool-rejected')`
    )

    // Act
    const followed = events.map((event) => ({ kind: event.kind, prompt: promptAfter(event.sessionId, event.at) }))
    const beforeLabelled = (kind: string): boolean =>
      followed.some((event) => event.kind === kind && event.prompt?.hasAct === 1)
    const unlabelled = rows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM message m JOIN session s ON s.id = m.session_id
       WHERE s.origin = 'interactive' AND m.actor = 'user' AND NOT EXISTS (
         SELECT 1 FROM label l WHERE l.record_type = 'message' AND l.record_id = m.id AND l.name = 'act')`
    )[0]?.count

    // Assert
    expect({
      interruptedBeforeLabelled: beforeLabelled('interrupted'),
      rejectedBeforeLabelled: beforeLabelled('tool-rejected'),
      interruptedBeforeUnlabelled: followed.some((event) => event.kind === 'interrupted' && event.prompt?.hasAct === 0),
      isFewUnlabelled: unlabelled !== undefined && unlabelled <= MAX_PROMPTS_WITHOUT_ACT,
    }).toStrictEqual({
      interruptedBeforeLabelled: true,
      rejectedBeforeLabelled: true,
      interruptedBeforeUnlabelled: true,
      isFewUnlabelled: true,
    })
  })

  it('run records: a sync ended ok, and four labelling runs at their planned times with their records counted', () => {
    // Arrange
    const planned = demo.plan.labels.runs
    const [first, ...samples] = planned
    const runs = rows<{ id: number; startedAt: number; endedAt: number; outcome: string; model: string }>(
      'SELECT id, started_at AS startedAt, ended_at AS endedAt, outcome, model FROM label_run ORDER BY started_at'
    )
    const tasks = rows<{ runId: number; task: string; version: number; planned: number; done: number }>(
      'SELECT run_id AS runId, task, version, planned, done FROM label_run_task ORDER BY run_id, task'
    )

    // Act
    const counted = tasks.map((row) => {
      const run = runs.find((candidate) => candidate.id === row.runId)
      const task = LABEL_TASKS.find((candidate) => candidate.name === row.task)
      if (run === undefined || task === undefined) {
        return { ...row, current: null, records: null }
      }
      const names = mainFields(task)
      const records = rows<{ count: number }>(
        `SELECT COUNT(DISTINCT record_id) AS count FROM label
         WHERE labeller = ? AND version = ? AND labelled_at >= ? AND labelled_at <= ?
           AND record_type = ? AND name IN (${names.map(() => '?').join(', ')})`,
        run.model,
        task.version,
        run.startedAt,
        run.endedAt,
        task.recordTypes[0] ?? '',
        ...names
      )[0]?.count
      return { ...row, current: task.version, records: records ?? null }
    })

    // Assert
    expect({
      syncs: rows<{ outcome: string }>('SELECT outcome FROM sync_run'),
      runs: runs.map(({ startedAt, endedAt, outcome, model }) => ({ startedAt, endedAt, outcome, model })),
      isSecondModel: samples.length === 3 && samples.every((run) => run.model !== first?.model),
      tasks: counted.map(({ version, current, done, planned: count, records }) => ({
        isCurrent: version === current,
        isDone: done === count && done === records,
      })),
    }).toStrictEqual({
      syncs: [{ outcome: 'ok' }],
      runs: planned.map(({ startedAt, endedAt, model }) => ({ startedAt, endedAt, outcome: 'ok', model })),
      isSecondModel: true,
      tasks: counted.map(() => ({ isCurrent: true, isDone: true })),
    })
  })

  it('labeller: a build without --model labels with claude-haiku-4-5', () => {
    // Act
    const firstRun = rows<{ model: string }>('SELECT model FROM label_run ORDER BY started_at LIMIT 1')[0]?.model
    const labellers = rows<{ labeller: string }>(
      `SELECT DISTINCT labeller FROM label WHERE labeller != 'rules' AND labelled_at < (
         SELECT ended_at FROM label_run ORDER BY started_at LIMIT 1) + 1`
    )

    // Assert
    expect({ firstRun, labellers }).toStrictEqual({
      firstRun: DEFAULT_LABELLER,
      labellers: [{ labeller: DEFAULT_LABELLER }],
    })
  })

  it('variant: the set without model labels writes no labelling run', () => {
    // Assert
    expect(variantRuns).toStrictEqual({ count: 0 })
  })
})
