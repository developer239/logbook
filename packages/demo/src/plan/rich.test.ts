import type { ISessionScript, ScriptStep } from '@log-book/adapter-api/source-writer'
import { claudeCodeSourceWriter } from '@log-book/adapter-claude-code/source-writer'
import { openCodeSourceWriter } from '@log-book/adapter-opencode/source-writer'
import {
  LABEL_TASK_NAMES,
  PROMPT_ACTS,
  REACTION_ABOUT,
  REACTION_REACH,
  REACTION_TARGETS,
  REACTIONS,
  REPLY_CODES,
  SESSION_OUTCOMES,
  SHELL_FAILURES,
  SHELL_PURPOSES,
  TOOL_FAILURE_CAUSES,
  type Reaction,
} from '@log-book/engine'
import { describe, expect, it } from 'vitest'
import { PLAN_CORPUS } from '../corpus/index.js'
import { MODELS } from '../corpus/models.js'
import { DAY_MS, dayStart, HOUR_MS } from './calendar.js'
import { indexRecords } from './label-records.js'
import { planLabels } from './labels.js'
import { planDataset } from './planner.js'
import { RICH_DAYS, RICH_RECENT } from './rich.js'
import { scriptPlan } from './scripts.js'
import type { IPlan, IPlanInputs, IWriterDeclaration } from './types.js'

type TCallStep = Extract<ScriptStep, { kind: 'call' }>

interface IWrittenStep {
  writer: number
  session: string
  step: ScriptStep
}

const ANCHOR = Date.UTC(2026, 8, 28, 18)
const WEEK_MS = 7 * DAY_MS
const RECENT_MS = 48 * HOUR_MS
const SLOW_MS = 30_000
const SLOW_FACTOR = 10
const NOT_SLOW = new Set(['subagent', 'dispatch', 'question', 'wait'])
// The weeks of the story before the developer asks for the tests in the task itself.
const EARLIER_WEEKS = 6

const WRITERS = [claudeCodeSourceWriter(), openCodeSourceWriter()] as const
const DECLARATIONS: readonly IWriterDeclaration[] = [
  { capabilities: [...WRITERS[0].capabilities], families: [...WRITERS[0].families], models: MODELS['claude-code'] },
  { capabilities: [...WRITERS[1].capabilities], families: [...WRITERS[1].families], models: MODELS.opencode },
]

const INPUTS: IPlanInputs = {
  size: 'rich',
  seed: 1,
  anchor: ANCHOR,
  labels: 'all',
  model: null,
  corpus: PLAN_CORPUS,
  writers: DECLARATIONS,
}

const sessionSteps = (writer: number, script: ISessionScript): IWrittenStep[] =>
  script.steps.flatMap((step) => [
    { writer, session: script.key, step },
    ...(step.kind === 'spawn' ? sessionSteps(writer, step.child) : []),
  ])

const plan = planDataset(INPUTS)
const written = scriptPlan(plan, INPUTS)
const labels = planLabels(plan, written, PLAN_CORPUS)
const steps = written.flatMap((scripts, writer) => scripts.scripts.flatMap((script) => sessionSteps(writer, script)))
const calls = steps.flatMap((entry) => (entry.step.kind === 'call' ? [{ ...entry, step: entry.step }] : []))
const replies = steps.flatMap(({ writer, step }) => (step.kind === 'reply' ? [{ writer, step }] : []))
const topLevel = plan.sessions.filter((session) => session.parentKey === null)

const familyOf = (step: ScriptStep): string | null => {
  if (step.kind === 'call') {
    return step.family === 'mcp' ? `mcp:${String(step.server)}` : step.family
  }
  if (step.kind === 'spawn') {
    return 'subagent'
  }
  return step.kind === 'skill' ? 'skill' : null
}

const durationOf = (step: TCallStep): number => (step.endAt ?? step.startAt) - step.startAt

const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const isScriptedRun = (step: TCallStep): boolean =>
  step.family === 'shell' && String(step.input.command).startsWith('claude -p ')

// Longer than 30 seconds and ten times the median of its writer's calls of its family, in a family the card keeps.
const isSlow = (call: IWrittenStep & { step: TCallStep }): boolean => {
  const usual = median(
    calls
      .filter((other) => other.writer === call.writer && other.step.family === call.step.family)
      .map((other) => durationOf(other.step))
  )
  const duration = durationOf(call.step)
  return (
    !NOT_SLOW.has(call.step.family) &&
    !isScriptedRun(call.step) &&
    written[call.writer]?.calls[call.step.key]?.shell?.purpose !== 'wait for something' &&
    duration > SLOW_MS &&
    duration > SLOW_FACTOR * usual
  )
}

const isFailedCall = ({ step }: { step: TCallStep }): boolean => step.status === 'error' && step.family !== 'shell'

const stepsIn = (session: string): ScriptStep[] =>
  steps.filter((entry) => entry.session === session).map(({ step }) => step)

const nextStep = (entry: IWrittenStep): ScriptStep | undefined => {
  const own = stepsIn(entry.session)
  return own.slice(own.indexOf(entry.step) + 1).find((step) => step.kind !== 'event')
}

// The agent got past a failed call when a later call of the same tool completed before the human's next prompt.
const isRecovered = (entry: IWrittenStep & { step: TCallStep }): boolean => {
  const own = stepsIn(entry.session)
  const after = own.slice(own.indexOf(entry.step) + 1)
  const prompt = after.findIndex((step) => step.kind === 'prompt' || step.kind === 'command')
  return (prompt === -1 ? after : after.slice(0, prompt)).some(
    (step) =>
      step.kind === 'call' &&
      step.status === 'completed' &&
      step.family === entry.step.family &&
      step.intent === entry.step.intent &&
      step.tool === entry.step.tool
  )
}

const writersWith = (type: string): Set<number> =>
  new Set(steps.flatMap(({ writer, step }) => (step.kind === 'event' && step.event.type === type ? [writer] : [])))

const stopOf = (step: ScriptStep): 'interrupt' | 'refuse' | null => {
  if (step.kind === 'interrupt') {
    return 'interrupt'
  }
  return step.kind === 'call' && step.status === 'rejected' ? 'refuse' : null
}

const isLabelled = (session: string): boolean =>
  plan.sessions.find((planned) => planned.key === session)?.outcome !== null

// When a record of the warehouse happened: a prompt, command or reply at its time, a call at its start.
const timeOf = (step: ScriptStep): number | null => {
  if (step.kind === 'prompt' || step.kind === 'command' || step.kind === 'reply') {
    return step.at
  }
  return step.kind === 'call' ? step.startAt : null
}

const isRecent = (recentPlan: IPlan, session: string | undefined): boolean =>
  (recentPlan.sessions.find((planned) => planned.key === session)?.end ?? 0) > recentPlan.anchor - RECENT_MS

const plannedReplies = written.flatMap((scripts) =>
  Object.entries(scripts.replies).map(([key, reply]) => ({ key, ...reply }))
)
const replyModels = new Map(replies.map(({ step }) => [step.key, step.model]))

// A model's share of its planned replies that carry the code.
const shareOf = (model: string, code: string): number => {
  const own = plannedReplies.filter((reply) => replyModels.get(reply.key) === model)
  return own.filter((reply) => reply.codes.some((candidate) => candidate === code)).length / own.length
}

// The model with the highest share of the code among the models.
const topOf = (models: readonly string[], code: string): string | undefined =>
  models.toSorted((left, right) => shareOf(right, code) - shareOf(left, code))[0]

const average = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length

describe('the rich plan coverage matrix', () => {
  it('rows 1 and 2: 84 days, the three projects, 150 top-level sessions in the first writer and 90 in the second, 20 scripted', () => {
    // Act
    const counts = [0, 1].map((writer) => topLevel.filter((session) => session.writer === writer).length)
    const scripted = plan.sessions.filter((session) => session.origin === 'scripted')

    // Assert
    expect({
      days: plan.days,
      counts,
      projects: [...new Set(topLevel.map((session) => session.project))].toSorted(),
      scripted: new Set(scripted.map((session) => session.writer)),
      scriptedCount: scripted.length,
    }).toStrictEqual({
      days: RICH_DAYS,
      counts: [150, 90],
      projects: ['billing', 'field-guide', 'shop'],
      scripted: new Set([0]),
      scriptedCount: 20,
    })
  })

  it('row 3: 70 subagents in the first writer, 3 of them nested, and 30 child sessions in the second', () => {
    // Act
    const started = plan.sessions.filter((session) => session.origin === 'subagent')
    const isNested = (key: string | null): boolean =>
      plan.sessions.find((session) => session.key === key)?.origin === 'subagent'

    // Assert
    expect({
      first: started.filter((session) => session.writer === 0).length,
      nested: started.filter((session) => isNested(session.parentKey)).length,
      second: started.filter((session) => session.writer === 1).length,
    }).toStrictEqual({ first: 70, nested: 3, second: 30 })
  })

  it('row 4: 6 scripted sessions started by a claude -p shell call in another session, at its time', () => {
    // Arrange
    const scripted = written[0]?.scripts.filter((script) => script.isScripted) ?? []
    const firsts = scripted.flatMap((script) => {
      const [first] = script.steps
      return first?.kind === 'prompt' ? [{ key: script.key, command: `claude -p "${first.text}"`, at: first.at }] : []
    })

    // Act
    const runs = calls.filter(({ step }) => isScriptedRun(step))
    const unmatched = runs.filter(
      ({ session, step }) =>
        !firsts.some(
          (first) => first.key !== session && first.command === step.input.command && first.at === step.startAt
        )
    )

    // Assert
    expect({ runs: runs.length, writers: new Set(runs.map(({ writer }) => writer)), unmatched }).toStrictEqual({
      runs: 6,
      writers: new Set([0]),
      unmatched: [],
    })
  })

  it('row 5: idle stretches, model time, tool time, human waits, wait calls and slow calls in both writers', () => {
    // Act
    const idle = plan.sessions.filter((session) =>
      session.turns.slice(1).some((turn, index) => turn.start - (session.turns[index]?.end ?? turn.start) > 10 * 60_000)
    )

    // Assert
    expect({
      isIdle: idle.length > 0,
      modelTime: replies.some(({ step }) => step.endAt > step.at),
      toolTime: calls.some(({ step }) => durationOf(step) > 0),
      humanWaits: new Set(
        calls
          .filter(({ step }) => step.family === 'question' && durationOf(step) >= SLOW_MS)
          .map(({ writer }) => writer)
      ),
      waits: new Set(calls.filter(({ step }) => step.family === 'wait').map(({ writer }) => writer)),
      slow: new Set(calls.filter(isSlow).map(({ writer }) => writer)),
    }).toStrictEqual({
      isIdle: true,
      modelTime: true,
      toolTime: true,
      humanWaits: new Set([0, 1]),
      waits: new Set([0, 1]),
      slow: new Set([0, 1]),
    })
  })

  it('row 6: 3 models in the first writer, 2 in the second, cache and reasoning tokens, model switches and cost in the second', () => {
    // Act
    const modelsOf = (writer: number): Set<string> =>
      new Set(replies.filter((reply) => reply.writer === writer).map(({ step }) => step.model))

    // Assert
    expect({
      models: [modelsOf(0).size, modelsOf(1).size],
      cacheRead: replies.some(({ step }) => (step.tokens?.cacheRead ?? 0) > 0),
      cacheWrite: replies.some(({ step }) => (step.tokens?.cacheWrite ?? 0) > 0),
      reasoning: replies.some(({ step }) => (step.tokens?.reasoning ?? 0) > 0),
      switches: writersWith('model-switch'),
      costs: [
        replies.some(({ writer, step }) => writer === 0 && step.cost !== null),
        replies.filter(({ writer }) => writer === 1).every(({ step }) => step.cost !== null),
      ],
    }).toStrictEqual({
      models: [3, 2],
      cacheRead: true,
      cacheWrite: true,
      reasoning: true,
      switches: new Set([1]),
      costs: [false, true],
    })
  })

  it('row 7: all 14 tool families', () => {
    // Act
    const families = new Set(steps.flatMap(({ step }) => familyOf(step) ?? []))

    // Assert
    expect([...families].toSorted()).toStrictEqual([
      'dispatch',
      'edit',
      'mcp:tracker',
      'other',
      'question',
      'read',
      'search',
      'shell',
      'skill',
      'subagent',
      'todo',
      'tool-search',
      'wait',
      'web',
    ])
  })

  it('row 8: tools offered only in the first writer, the calendar server failing, and tools loaded in the same session', () => {
    // Act
    const offered = steps.flatMap(({ writer, session, step }) =>
      step.kind === 'event' && step.event.type === 'tools-offered'
        ? [{ writer, session, failed: step.event.failedServers.map((server) => server.name) }]
        : []
    )
    const loaded = new Set(
      steps.flatMap(({ session, step }) =>
        step.kind === 'event' && step.event.type === 'tools-loaded' ? [session] : []
      )
    )

    // Assert
    expect({
      writers: new Set(offered.map(({ writer }) => writer)),
      failed: new Set(offered.flatMap(({ failed }) => failed)),
      isLoadedThere: offered.every(({ session }) => loaded.has(session)),
    }).toStrictEqual({ writers: new Set([0]), failed: new Set(['calendar']), isLoadedThere: true })
  })

  it('row 9: the write-release-notes and review-checklist skills in both writers', () => {
    // Act
    const skills = [0, 1].map(
      (writer) =>
        new Set(
          steps.flatMap((entry) => (entry.writer === writer && entry.step.kind === 'skill' ? [entry.step.name] : []))
        )
    )

    // Assert
    expect(skills).toStrictEqual([
      new Set(['review-checklist', 'write-release-notes']),
      new Set(['review-checklist', 'write-release-notes']),
    ])
  })

  it('row 10: /review, /release-notes and /model typed in the first writer, /review and /release-notes as templates in the second', () => {
    // Act
    const commands = [0, 1].map(
      (writer) =>
        new Set(
          steps.flatMap((entry) =>
            entry.writer === writer && entry.step.kind === 'command'
              ? [`${entry.step.name} ${entry.step.body === null ? 'typed' : 'template'}`]
              : []
          )
        )
    )

    // Assert
    expect(commands).toStrictEqual([
      new Set(['model typed', 'release-notes typed', 'review typed']),
      new Set(['release-notes template', 'review template']),
    ])
  })

  it('row 11: every shell purpose, most settled by the rules and some left to the model, and every failure', () => {
    // Act
    const shell = calls
      .filter(({ step }) => step.family === 'shell')
      .map(({ writer, step }) => written[writer]?.calls[step.key]?.shell ?? null)
    const settled = shell.filter((label) => label?.isRuleSettled === true).length

    // Assert
    expect({
      labelled: shell.every((label) => label !== null),
      purposes: SHELL_PURPOSES.filter((purpose) => shell.some((label) => label?.purpose === purpose)),
      isMostlySettled: settled > shell.length / 2,
      isSomeLeft: settled < shell.length,
      failures: SHELL_FAILURES.filter((failure) => shell.some((label) => label?.failure === failure)),
    }).toStrictEqual({
      labelled: true,
      purposes: [...SHELL_PURPOSES],
      isMostlySettled: true,
      isSomeLeft: true,
      failures: [...SHELL_FAILURES],
    })
  })

  it('row 12: failed calls of all 12 causes, settled and not, recovered and not, and retry loops', () => {
    // Arrange
    const failed = calls.filter(isFailedCall)
    const failures = failed.map(({ writer, step }) => written[writer]?.calls[step.key]?.failure ?? null)

    // Act
    const same = Map.groupBy(calls, ({ session, step }) => `${session} ${step.family} ${JSON.stringify(step.input)}`)
    const loops = [...same.values()].filter(
      (group) => group.map(({ step }) => step.status).join(' ') === 'error error error completed'
    )

    // Assert
    expect({
      causes: TOOL_FAILURE_CAUSES.filter((cause) => failures.some((label) => label?.cause === cause)),
      settled: new Set(failures.map((label) => label?.isRuleSettled)),
      recovered: new Set(failed.map(isRecovered)),
      isLooping: loops.length > 1,
    }).toStrictEqual({
      causes: [...TOOL_FAILURE_CAUSES],
      settled: new Set([true, false]),
      recovered: new Set([true, false]),
      isLooping: true,
    })
  })

  it('row 13: compactions and failed requests in both writers, agent switches and idle only in the second', () => {
    // Act
    const writers = ['compaction', 'failed-request', 'agent-switch', 'idle'].map(writersWith)

    // Assert
    expect(writers).toStrictEqual([new Set([0, 1]), new Set([0, 1]), new Set([1]), new Set([1])])
  })

  it('row 14: interruptions and refused calls in both writers, followed by prompts labelled and not', () => {
    // Act
    const stops = steps.flatMap((entry) => {
      const kind = stopOf(entry.step)
      return kind === null
        ? []
        : [
            {
              kind,
              writer: entry.writer,
              isPromptNext: nextStep(entry)?.kind === 'prompt',
              isLabelled: isLabelled(entry.session),
            },
          ]
    })
    const followed = stops.filter((stop) => stop.isPromptNext)

    // Assert
    expect({
      writers: ['interrupt', 'refuse'].map(
        (kind) => new Set(stops.filter((stop) => stop.kind === kind).map((stop) => stop.writer))
      ),
      labelled: ['interrupt', 'refuse'].map((kind) => followed.some((stop) => stop.kind === kind && stop.isLabelled)),
      isAnyUnlabelled: followed.some((stop) => !stop.isLabelled),
    }).toStrictEqual({
      writers: [new Set([0, 1]), new Set([0, 1])],
      labelled: [true, true],
      isAnyUnlabelled: true,
    })
  })

  it('row 15: every act, every reaction kind, about, target and reach, and an act for every prompt', () => {
    // Act
    const acts = written.flatMap((scripts) => Object.values(scripts.acts))
    const reactions = written.flatMap((scripts) => Object.values(scripts.reactions).flat())
    const prompts = steps.filter(({ step }) => step.kind === 'prompt')

    // Assert
    expect({
      acts: PROMPT_ACTS.filter((act) => acts.includes(act)),
      kinds: REACTIONS.filter((kind) => reactions.some((reaction) => reaction.reaction === kind)),
      about: REACTION_ABOUT.filter((about) => reactions.some((reaction) => reaction.about === about)),
      targets: REACTION_TARGETS.filter((target) => reactions.some((reaction) => reaction.target === target)),
      reach: REACTION_REACH.filter((reach) => reactions.some((reaction) => reaction.reach === reach)),
      tagged: prompts.every(({ writer, step }) => written[writer]?.acts[step.key] !== undefined),
    }).toStrictEqual({
      acts: [...PROMPT_ACTS],
      kinds: [...REACTIONS],
      about: [...REACTION_ABOUT],
      targets: [...REACTION_TARGETS],
      reach: [...REACTION_REACH],
      tagged: true,
    })
  })

  it('row 16: every reply code, quotes, and permission, caves and pushback each from two models', () => {
    // Act
    const modelsOf = (code: string): number =>
      new Set(
        plannedReplies
          .filter((reply) => reply.codes.some((candidate) => candidate === code))
          .map((reply) => replyModels.get(reply.key))
      ).size

    // Assert
    expect({
      codes: REPLY_CODES.filter((code) => plannedReplies.some((reply) => reply.codes.includes(code))),
      isQuoted: plannedReplies.some((reply) => reply.quote !== null),
      isFromTwoModels: ['permission', 'caves', 'pushback'].map((code) => modelsOf(code) >= 2),
    }).toStrictEqual({ codes: [...REPLY_CODES], isQuoted: true, isFromTwoModels: [true, true, true] })
  })

  it('row 17: 12 goals and all 8 outcomes among the labelled sessions', () => {
    // Act
    const labelled = topLevel.filter((session) => session.outcome !== null)

    // Assert
    expect({
      goals: new Set(labelled.map((session) => session.goal)).size,
      outcomes: SESSION_OUTCOMES.filter((outcome) => labelled.some((session) => session.outcome === outcome)),
    }).toStrictEqual({ goals: 12, outcomes: [...SESSION_OUTCOMES] })
  })

  it('row 18: the sessions of the last 48 hours get no model label, and the time rules hold', () => {
    // Arrange
    const index = indexRecords(plan, written)
    const sessionOf = (key: string): string =>
      index.shellCalls.get(key) ??
      index.failedCalls.get(key) ??
      index.prompts.get(key)?.session ??
      index.replies.get(key)?.session ??
      key

    // Act
    const recent = topLevel.filter((session) => isRecent(plan, session.key))
    const recentLabels = labels.labels.filter((label) => isRecent(plan, sessionOf(label.recordKey.split('#')[0] ?? '')))

    // Assert
    expect({
      recent: recent.length,
      unlabelled: recent.every((session) => session.goal === null && session.outcome === null),
      recentLabels: recentLabels.length,
      isInSpan: plan.sessions.every(
        (session) => session.start >= dayStart(plan.anchor, 0, plan.days) && session.end < plan.anchor
      ),
      newestEnd: plan.anchor - Math.max(...plan.sessions.map((session) => session.end)) < HOUR_MS,
      quietHour: plan.sessions.every(
        (session) => session.end <= plan.anchor - RECENT_MS || session.start >= plan.anchor - 47 * HOUR_MS
      ),
    }).toStrictEqual({
      recent: RICH_RECENT,
      unlabelled: true,
      recentLabels: 0,
      isInSpan: true,
      newestEnd: true,
      quietHour: true,
    })
  })

  it("rows 19 and 24: 4 labelling runs one after another before the anchor, the second model's sample of 200 shell calls and 20 prompts with their replies", () => {
    // Act
    const runs = labels.runs.map((run) => ({
      command: run.command,
      model: run.model,
      tasks: run.tasks.map(({ task, planned, done }) => [task, planned === done]),
    }))
    const isInTurn = labels.runs.every(
      (run, index) => run.startedAt < run.endedAt && run.startedAt >= (labels.runs[index - 1]?.endedAt ?? 0)
    )

    // Assert
    expect({ runs, isInTurn, isBeforeAnchor: labels.runs.every((run) => run.endedAt < ANCHOR) }).toStrictEqual({
      runs: [
        {
          command: 'logbook labels update',
          model: 'claude-haiku-4-5',
          tasks: LABEL_TASK_NAMES.map((task) => [task, true]),
        },
        ...(['shell', 'prompt', 'reply'] as const).map((task) => ({
          command: `logbook labels run --task ${task} --sample ${task === 'shell' ? '200' : '20'} --model claude-sonnet-5-5`,
          model: 'claude-sonnet-5-5',
          tasks: [[task, true]],
        })),
      ],
      isInTurn: true,
      isBeforeAnchor: true,
    })
  })

  it('row 20: 84 days, with some days empty', () => {
    // Act
    const days = new Set(
      plan.sessions.map((session) => Math.floor((session.start - dayStart(plan.anchor, 0, plan.days)) / DAY_MS))
    )

    // Assert
    expect({ days: plan.days, isSpread: days.size > RICH_DAYS / 2 && days.size < RICH_DAYS }).toStrictEqual({
      days: RICH_DAYS,
      isSpread: true,
    })
  })

  it('row 21: branches, titled and untitled sessions and agents only where declared, and a search phrase in one output', () => {
    // Arrange
    const phrase = PLAN_CORPUS.tools.searchPhrase

    // Act
    const outputs = calls.filter(({ step }) => step.result?.includes(phrase) === true)
    const texts = steps.filter(
      ({ step }) => (step.kind === 'prompt' || step.kind === 'reply') && step.text?.includes(phrase) === true
    )

    // Assert
    expect({
      branches: new Set(topLevel.map((session) => session.gitBranch !== null && session.writer)),
      titles: new Set(topLevel.map((session) => session.title === null)),
      agents: new Set(topLevel.map((session) => session.agent !== null && session.writer)),
      outputs: outputs.length,
      texts: texts.length,
    }).toStrictEqual({
      branches: new Set([0, false]),
      titles: new Set([false, true]),
      agents: new Set([false, 1]),
      outputs: 1,
      texts: 0,
    })
  })
})

describe('the rich plan coverage matrix, row 25', () => {
  it('holds 1 showcase conversation in rich and none in small', () => {
    // Act
    const showcases = [plan, planDataset({ ...INPUTS, size: 'small' })].map(
      (sized) => sized.sessions.filter((session) => session.shape === 'showcase' && session.parentKey === null).length
    )

    // Assert
    expect(showcases).toStrictEqual([1, 0])
  })
})

describe("the rich plan's story", () => {
  it('corrects more than it praises on average in weeks 1 to 6, and praises more than it corrects from week 7', () => {
    // Arrange
    const start = dayStart(plan.anchor, 0, plan.days)
    const prompts = steps.flatMap(({ writer, step }) =>
      step.kind === 'prompt' && written[writer]?.acts[step.key] !== undefined
        ? [
            {
              week: Math.floor((step.at - start) / WEEK_MS),
              kinds: new Set((written[writer].reactions[step.key] ?? []).map((reaction) => reaction.reaction)),
            },
          ]
        : []
    )

    // Act
    const weekly = (kind: Reaction): number[] =>
      Array.from({ length: RICH_DAYS / 7 }, (_week, week) => {
        const own = prompts.filter((prompt) => prompt.week === week)
        return own.filter((prompt) => prompt.kinds.has(kind)).length / own.length
      })
    const [corrections, praise] = [weekly('correction'), weekly('praise')]

    // Assert
    expect({
      earlier: average(corrections.slice(0, EARLIER_WEEKS)) > average(praise.slice(0, EARLIER_WEEKS)),
      later: average(corrections.slice(EARLIER_WEEKS)) < average(praise.slice(EARLIER_WEEKS)),
    }).toStrictEqual({ earlier: true, later: true })
  })

  it('has one Claude Code model ask permission most among them, and one OpenCode model push back most of all', () => {
    // Act
    const permission = topOf(MODELS['claude-code'], 'permission')
    const pushback = topOf([...MODELS['claude-code'], ...MODELS.opencode], 'pushback')

    // Assert
    expect({ permission, pushback }).toStrictEqual({ permission: 'claude-opus-5-5', pushback: 'openai/gpt-5.5' })
  })

  it('puts between 5% and 9% of the records in the last 48 hours', () => {
    // Act
    const times = steps.flatMap(({ step }) => timeOf(step) ?? [])
    const share = times.filter((at) => at > ANCHOR - RECENT_MS).length / times.length

    // Assert
    expect({ isAbove: share >= 0.05, isBelow: share <= 0.09 }).toStrictEqual({ isAbove: true, isBelow: true })
  })
})
