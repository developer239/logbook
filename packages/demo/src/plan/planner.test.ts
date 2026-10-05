import { describe, expect, it } from 'vitest'
import { PROJECTS } from '../corpus/projects.js'
import { WORK } from '../corpus/work.js'
import { DAY_MS, dayStart, HOUR_MS } from './calendar.js'
import { planDataset } from './planner.js'
import type { IPlan, IPlanInputs, IWriterDeclaration } from './types.js'

const DEFAULT_ANCHOR = Date.UTC(2026, 8, 28, 18)
const WEEK_MS = 7 * DAY_MS

// What the two writers declare: the first like Claude Code's, the second like OpenCode's.
const FIRST_WRITER: IWriterDeclaration = {
  capabilities: [
    'git-branch',
    'scripted',
    'image',
    'mcp-server',
    'typed-command',
    'nested-subagent',
    'tools-offered',
    'tools-loaded',
    'interrupt',
    'tool-reject',
  ],
  families: [
    'shell',
    'read',
    'edit',
    'search',
    'web',
    'todo',
    'question',
    'tool-search',
    'wait',
    'dispatch',
    'mcp',
    'other',
  ],
}
const SECOND_WRITER: IWriterDeclaration = {
  capabilities: [
    'session-agent',
    'scripted',
    'image',
    'reported-cost',
    'template-command',
    'model-switch',
    'agent-switch',
    'idle-event',
    'interrupt',
    'tool-reject',
  ],
  families: ['shell', 'read', 'edit', 'search', 'web', 'question', 'wait', 'dispatch', 'other'],
}

const inputs = (fields: Partial<IPlanInputs> = {}): IPlanInputs => ({
  size: 'small',
  seed: 1,
  anchor: DEFAULT_ANCHOR,
  labels: 'all',
  model: 'claude-haiku-4-5',
  corpus: { projects: PROJECTS, work: WORK },
  writers: [FIRST_WRITER, SECOND_WRITER],
  ...fields,
})

const topLevel = (plan: IPlan): IPlan['sessions'] => plan.sessions.filter((session) => session.parentKey === null)

const withoutCapability = (writer: IWriterDeclaration, capability: string): IWriterDeclaration => ({
  ...writer,
  capabilities: writer.capabilities.filter((candidate) => candidate !== capability),
})

// The time rules: every time inside the span and before the anchor, the newest sessions end within the hour before
// it, exactly two top-level sessions end in the 48 hours before it, and none runs between 48 and 47 hours before it.
const timeRules = (plan: IPlan): Record<string, unknown> => ({
  isInSpan: plan.sessions.every(
    (session) => session.start >= dayStart(plan.anchor, 0, plan.days) && session.end < plan.anchor
  ),
  newestEnd: plan.anchor - Math.max(...plan.sessions.map((session) => session.end)) < HOUR_MS,
  recent: topLevel(plan).filter((session) => session.end > plan.anchor - 48 * HOUR_MS).length,
  quietHour: plan.sessions.every(
    (session) => session.end <= plan.anchor - 48 * HOUR_MS || session.start >= plan.anchor - 47 * HOUR_MS
  ),
  isWholeMilliseconds: plan.sessions.every(
    (session) => Number.isInteger(session.start) && Number.isInteger(session.end)
  ),
})

describe('the small plan coverage matrix', () => {
  const plan = planDataset(inputs())
  const labelled = topLevel(plan).filter((session) => session.outcome !== null)

  it('row 1: 8 top-level sessions in the first writer and 6 in the second', () => {
    // Act
    const counts = [0, 1].map((writer) => topLevel(plan).filter((session) => session.writer === writer).length)

    // Assert
    expect(counts).toStrictEqual([8, 6])
  })

  it('row 2: 1 scripted session', () => {
    // Act
    const scripted = plan.sessions.filter((session) => session.origin === 'scripted')

    // Assert
    expect(scripted.map((session) => session.writer)).toStrictEqual([0])
  })

  it('row 3: 3 subagents in the first writer, 1 of them nested, and 2 child sessions in the second', () => {
    // Act
    const started = plan.sessions.filter((session) => session.origin === 'subagent')
    const isNested = (key: string | null): boolean =>
      plan.sessions.find((session) => session.key === key)?.origin === 'subagent'

    // Assert
    expect({
      first: started.filter((session) => session.writer === 0).length,
      nested: started.filter((session) => isNested(session.parentKey)).length,
      second: started.filter((session) => session.writer === 1).length,
      all: plan.sessions.length,
    }).toStrictEqual({ first: 3, nested: 1, second: 2, all: 19 })
  })

  it('row 5: an idle stretch of more than 10 minutes between two turns', () => {
    // Act
    const longest = Math.max(
      ...plan.sessions.flatMap((session) =>
        session.turns.slice(1).map((turn, index) => turn.start - (session.turns[index]?.end ?? turn.start))
      )
    )

    // Assert
    expect(longest).toBeGreaterThan(10 * 60_000)
  })

  it('row 17: 6 goals and all 8 outcomes among the labelled sessions', () => {
    // Act
    const goals = new Set(labelled.map((session) => session.goal))
    const outcomes = new Set(labelled.map((session) => session.outcome))

    // Assert
    expect({
      goals: goals.size,
      outcomes: [...outcomes].toSorted((left, right) => (String(left) < String(right) ? -1 : 1)),
    }).toStrictEqual({
      goals: 6,
      outcomes: ['abandoned', 'blocked', 'done', 'failed', 'handed off', 'no task', 'partly done', 'unclear'],
    })
  })

  it('row 18: the 2 sessions that ended in the last 48 hours are unlabelled', () => {
    // Act
    const recent = topLevel(plan).filter((session) => session.end > plan.anchor - 48 * HOUR_MS)

    // Assert
    expect(recent.map(({ goal, outcome }) => ({ goal, outcome }))).toStrictEqual([
      { goal: null, outcome: null },
      { goal: null, outcome: null },
    ])
  })

  it('row 20: 21 days, with some days empty', () => {
    // Act
    const days = new Set(
      plan.sessions.map((session) => Math.floor((session.start - dayStart(plan.anchor, 0, plan.days)) / DAY_MS))
    )

    // Assert
    expect({ days: plan.days, isSpread: days.size > 5 && days.size < plan.days }).toStrictEqual({
      days: 21,
      isSpread: true,
    })
  })

  it('row 21: git branches, titled and untitled sessions, and agents only where a writer declares them', () => {
    // Act
    const sessions = topLevel(plan)

    // Assert
    expect({
      branches: new Set(sessions.map((session) => session.gitBranch !== null && session.writer)),
      titled: sessions.filter((session) => session.title !== null).length,
      untitled: sessions.filter((session) => session.title === null).length,
      agents: new Set(sessions.map((session) => session.agent !== null && session.writer)),
    }).toStrictEqual({ branches: new Set([0, false]), titled: 12, untitled: 2, agents: new Set([false, 1]) })
  })
})

describe('planDataset', () => {
  it('gives an equal plan for equal inputs, which reads back from JSON as an equal value', () => {
    // Act
    const [first, second] = [planDataset(inputs()), planDataset(inputs())]

    // Assert
    expect({ isEqual: first, readBack: JSON.parse(JSON.stringify(first)) as unknown }).toStrictEqual({
      isEqual: second,
      readBack: first,
    })
  })

  it('moves every time by exactly a week for an anchor a week later, with the same keys in the same order', () => {
    // Act
    const [base, later] = [planDataset(inputs()), planDataset(inputs({ anchor: DEFAULT_ANCHOR + WEEK_MS }))]

    // Assert
    expect(
      later.sessions.map((session) => ({
        ...session,
        start: session.start - WEEK_MS,
        end: session.end - WEEK_MS,
        turns: session.turns.map((turn) => ({ start: turn.start - WEEK_MS, end: turn.end - WEEK_MS })),
      }))
    ).toStrictEqual(base.sessions.map((session) => session))
    expect(later.anchor - base.anchor).toBe(WEEK_MS)
  })

  it('keeps the same keys in the same order for anchors at different hours', () => {
    // Act
    const keys = [DEFAULT_ANCHOR, DEFAULT_ANCHOR - 15 * HOUR_MS, DEFAULT_ANCHOR + 5 * HOUR_MS + 1_234].map((anchor) =>
      planDataset(inputs({ anchor })).sessions.map((session) => session.key)
    )

    // Assert
    expect(keys[1]).toStrictEqual(keys[0])
    expect(keys[2]).toStrictEqual(keys[0])
  })

  it.each([
    ['the default anchor', DEFAULT_ANCHOR],
    ['an anchor just after midnight', Date.UTC(2026, 10, 3, 0, 20)],
    ['an anchor late in the day on another date and seed', Date.UTC(2027, 1, 14, 23, 59, 30)],
  ])('keeps the time rules for %s', (_case, anchor) => {
    // Act
    const rules = [1, 7].map((seed) => timeRules(planDataset(inputs({ anchor, seed }))))

    // Assert
    const expected = { isInSpan: true, newestEnd: true, recent: 2, quietHour: true, isWholeMilliseconds: true }
    expect(rules).toStrictEqual([expected, expected])
  })

  it.each([
    ['scripted', (plan: IPlan) => plan.sessions.filter((session) => session.origin === 'scripted').length],
    [
      'nested-subagent',
      (plan: IPlan) =>
        plan.sessions.filter(
          (session) => plan.sessions.find((parent) => parent.key === session.parentKey)?.origin === 'subagent'
        ).length,
    ],
    ['git-branch', (plan: IPlan) => plan.sessions.filter((session) => session.gitBranch !== null).length],
    ['session-agent', (plan: IPlan) => plan.sessions.filter((session) => session.agent !== null).length],
  ])('gives no session or field that needs %s to writers that leave it out', (capability, needing) => {
    // Act
    const plan = planDataset(
      inputs({ writers: [withoutCapability(FIRST_WRITER, capability), withoutCapability(SECOND_WRITER, capability)] })
    )

    // Assert
    expect(needing(plan)).toBe(0)
  })

  it('plans no labels and no labelling model with the labels variant none', () => {
    // Act
    const plan = planDataset(inputs({ labels: 'none' }))

    // Assert
    expect({
      model: plan.labelModel,
      labelled: plan.sessions.filter((session) => session.outcome !== null || session.goal !== null).length,
    }).toStrictEqual({
      model: null,
      labelled: 0,
    })
  })
})
