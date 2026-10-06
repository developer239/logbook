import type { ISessionScript, ScriptStep } from '@log-book/adapter-api/source-writer'
import { claudeCodeSourceWriter } from '@log-book/adapter-claude-code/source-writer'
import { openCodeSourceWriter } from '@log-book/adapter-opencode/source-writer'
import { describe, expect, it } from 'vitest'
import { PLAN_CORPUS } from '../corpus/index.js'
import { MODELS } from '../corpus/models.js'
import { DAY_MS } from './calendar.js'
import { planLabels } from './labels.js'
import { planDataset } from './planner.js'
import { scriptPlan } from './scripts.js'
import type { IPlan, IPlanInputs, IPlannedSession, IPlannedTurn, IWriterDeclaration, IWriterScripts } from './types.js'

type TCallStep = Extract<ScriptStep, { kind: 'call' }>

const MINUTE_MS = 60_000
const SLOW_MS = 30_000
const SLOW_FACTOR = 10
const WRITERS = [claudeCodeSourceWriter(), openCodeSourceWriter()] as const
const DECLARATIONS: readonly IWriterDeclaration[] = [
  { capabilities: [...WRITERS[0].capabilities], families: [...WRITERS[0].families], models: MODELS['claude-code'] },
  { capabilities: [...WRITERS[1].capabilities], families: [...WRITERS[1].families], models: MODELS.opencode },
]
const ANCHORS = [Date.UTC(2026, 8, 28, 18), Date.UTC(2027, 1, 14, 23)]
const CASES = [1, 2].flatMap((seed) => ANCHORS.map((anchor) => [seed, anchor] as const))

const inputs = (seed: number, anchor: number): IPlanInputs => ({
  size: 'rich',
  seed,
  anchor,
  labels: 'all',
  model: null,
  corpus: PLAN_CORPUS,
  writers: DECLARATIONS,
})

// A script's steps by turn: each prompt with the steps after it, up to the next prompt.
const turnsOf = (script: ISessionScript): ScriptStep[][] =>
  script.steps.reduce<ScriptStep[][]>(
    (turns, step) =>
      step.kind === 'prompt' ? [...turns, [step]] : [...turns.slice(0, -1), [...(turns.at(-1) ?? []), step]],
    []
  )

// The steps the conversation page counts in a turn: the agent's replies and its calls.
const stepCount = (turn: readonly ScriptStep[]): number =>
  turn.filter((step) => step.kind === 'reply' || step.kind === 'call' || step.kind === 'spawn' || step.kind === 'skill')
    .length

const callsIn = (steps: readonly ScriptStep[]): TCallStep[] =>
  steps.flatMap((step) => (step.kind === 'call' ? [step] : []))

const durationOf = (step: TCallStep): number => (step.endAt ?? step.startAt) - step.startAt

const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

// Whether a span runs inside another, both present.
const isWithin = (inner: IPlannedTurn | undefined, outer: IPlannedTurn | undefined): boolean =>
  inner !== undefined && outer !== undefined && inner.start > outer.start && inner.end < outer.end

const allSteps = (script: ISessionScript): ScriptStep[] =>
  script.steps.flatMap((step) => [step, ...(step.kind === 'spawn' ? allSteps(step.child) : [])])

// The plan's showcase conversation, its writer's scripts and its own script.
const showcaseIn = (
  plan: IPlan,
  written: readonly IWriterScripts[]
): { session: IPlannedSession; scripts: IWriterScripts; script: ISessionScript } => {
  const session = plan.sessions.find((candidate) => candidate.shape === 'showcase' && candidate.parentKey === null)
  const scripts = written[session?.writer ?? -1]
  const script = scripts?.scripts.find((candidate) => candidate.key === session?.key)
  if (session === undefined || scripts === undefined || script === undefined) {
    throw new Error('The plan holds no showcase conversation')
  }
  return { session, scripts, script }
}

// The first script of the first writer, for a seed and an anchor.
const firstScript = (seed: number, anchor: number): ISessionScript | undefined => {
  const planInputs = inputs(seed, anchor)
  return scriptPlan(planDataset(planInputs), planInputs)[0]?.scripts[0]
}

describe.each(CASES)('the rich plan with seed %i and anchor %i', (seed, anchor) => {
  const planInputs = inputs(seed, anchor)
  const plan = planDataset(planInputs)
  const written = scriptPlan(plan, planInputs)
  const labels = planLabels(plan, written, PLAN_CORPUS)
  const { session, scripts, script } = showcaseIn(plan, written)
  const turns = turnsOf(script)
  const turnCalls = turns.map(callsIn)
  const prompts = turns.map((turn) => turn[0]?.key ?? '')

  it('holds the showcase conversation as the first script of a writer that declares what it needs', () => {
    // Act
    const declaration = DECLARATIONS[session.writer]

    // Assert
    expect({
      key: session.key,
      isFirstSession: plan.sessions[0]?.key === session.key,
      isFirstScript: scripts.scripts[0]?.key === session.key,
      writer: session.writer,
      declares: ['nested-subagent', 'interrupt', 'git-branch'].every((capability) =>
        declaration?.capabilities.includes(capability)
      ),
      origin: session.origin,
      project: session.project,
      title: session.title,
      isOnBranch: session.gitBranch !== null,
      work: session.work,
    }).toStrictEqual({
      key: 'shop/showcase',
      isFirstSession: true,
      isFirstScript: true,
      writer: 0,
      declares: true,
      origin: 'interactive',
      project: 'shop',
      title: 'add a discount code field to checkout',
      isOnBranch: true,
      work: 'add a discount code field to checkout',
    })
  })

  it('ends between 2 and 6 days before the anchor', () => {
    // Act
    const before = anchor - session.end

    // Assert
    expect({ isAfter: before > 2 * DAY_MS, isBefore: before < 6 * DAY_MS }).toStrictEqual({
      isAfter: true,
      isBefore: true,
    })
  })

  it('runs 20 turns of 3 to 12 steps, one under a minute and one over 15 minutes, with an idle stretch of over 10 minutes', () => {
    // Act
    const planned = session.turns
    const lengths = planned.map((turn) => turn.end - turn.start)
    const gaps = planned.slice(1).map((turn, index) => turn.start - (planned[index]?.end ?? turn.start))

    // Assert
    expect({
      turns: turns.length,
      plannedTurns: planned.length,
      steps: turns.every((turn) => stepCount(turn) >= 3 && stepCount(turn) <= 12),
      isShort: Math.min(...lengths) < MINUTE_MS,
      isLong: Math.max(...lengths) > 15 * MINUTE_MS,
      isIdle: Math.max(...gaps) > 10 * MINUTE_MS,
    }).toStrictEqual({ turns: 20, plannedTurns: 20, steps: true, isShort: true, isLong: true, isIdle: true })
  })

  it('calls at least six tool families, among them shell, edit and subagent, and makes one slow call', () => {
    // Arrange
    const families = new Set(
      turns.flat().flatMap((step) => {
        if (step.kind === 'spawn') {
          return ['subagent']
        }
        return step.kind === 'call' ? [step.family] : []
      })
    )
    const writerCalls = scripts.scripts.flatMap((each) => callsIn(allSteps(each)))
    const usual = (family: string): number =>
      median(writerCalls.filter((call) => call.family === family).map(durationOf))

    // Act
    const slow = turnCalls
      .flat()
      .filter((call) => durationOf(call) > SLOW_MS && durationOf(call) > SLOW_FACTOR * usual(call.family))

    // Assert
    expect({
      isSixOrMore: families.size >= 6,
      named: ['shell', 'edit', 'subagent'].every((family) => families.has(family)),
      slow: slow.length,
    }).toStrictEqual({ isSixOrMore: true, named: true, slow: 1 })
  })

  it('starts a subagent in turn 8 that runs 4 turns of its own', () => {
    // Act
    const spawns = turns.flatMap((turn, index) =>
      turn.flatMap((step) => (step.kind === 'spawn' ? [{ turn: index + 1, child: step.child }] : []))
    )
    const child = plan.sessions.find((candidate) => candidate.parentKey === session.key)

    // Assert
    expect({
      spawns: spawns.map(({ turn, child: started }) => ({ turn, turns: turnsOf(started).length })),
      plannedTurns: child?.turns.length,
      isInsideTurn8: isWithin(child, session.turns[7]),
    }).toStrictEqual({ spawns: [{ turn: 8, turns: 4 }], plannedTurns: 4, isInsideTurn8: true })
  })

  it('interrupts a commit in turn 6, fails the tests three times in turn 12 before they pass, and compacts once', () => {
    // Act
    const interrupted = turns.flatMap((turn, index) =>
      turn.some((step) => step.kind === 'interrupt') ? [index + 1] : []
    )
    const stopped = turnCalls[5]?.find((call) => call.status === 'pending')
    const tests = (turnCalls[11] ?? [])
      .filter((call) => call.family === 'shell' && call.input.command === 'pnpm test')
      .map((call) => call.status)
    const compactions = turns.flat().filter((step) => step.kind === 'event' && step.event.type === 'compaction')

    // Assert
    expect({
      interrupted,
      stopped: stopped?.input.command,
      tests,
      compactions: compactions.length,
    }).toStrictEqual({
      interrupted: [6],
      stopped: 'git commit -am "add a discount code field to checkout"',
      tests: ['error', 'error', 'error', 'completed'],
      compactions: 1,
    })
  })

  it('plans a correction in turn 4, pushback after the interruption, praise on the last turn, codes on the replies, a goal and done', () => {
    // Act
    const reactions = prompts.flatMap((key, index) =>
      (scripts.reactions[key] ?? []).map((reaction) => ({ turn: index + 1, reaction: reaction.reaction }))
    )
    const coded = turns.filter((turn) =>
      turn.some((step) => step.kind === 'reply' && scripts.replies[step.key] !== undefined)
    )
    const labelled = (name: string): string | undefined =>
      labels.labels.find(
        (label) => label.recordKey === session.key && label.recordType === 'session' && label.name === name
      )?.value

    // Assert
    expect({
      reactions,
      coded: coded.length,
      goal: session.goal,
      outcome: session.outcome,
      labels: [labelled('goal'), labelled('outcome')],
    }).toStrictEqual({
      reactions: [
        { turn: 4, reaction: 'correction' },
        { turn: 7, reaction: 'pushback' },
        { turn: 20, reaction: 'praise' },
      ],
      coded: 19,
      goal: 'build a feature',
      outcome: 'done',
      labels: ['build a feature', 'done'],
    })
  })
})

describe('the showcase conversation', () => {
  it('is the same for every seed, and moves only with the anchor', () => {
    // Arrange
    const [anchor] = ANCHORS
    const shifted = (at: number): string =>
      JSON.stringify(firstScript(1, at)).replaceAll(
        /"(?<field>at|endAt|startAt)":(?<time>\d+)/gu,
        (_match, field: string, time: string) => `"${field}":${String(Number(time) - at)}`
      )

    // Act
    const [first, second] = [firstScript(1, anchor ?? 0), firstScript(2, anchor ?? 0)]

    // Assert
    expect({ isSeedFree: first, isAnchorShifted: shifted(ANCHORS[1] ?? 0) }).toStrictEqual({
      isSeedFree: second,
      isAnchorShifted: shifted(anchor ?? 0),
    })
  })
})
