import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkScripts,
  SOURCE_CAPABILITIES,
  type ISessionScript,
  type ISourceWriter,
  type ScriptStep,
} from '@log-book/adapter-api/source-writer'
import { claudeCodeSourceWriter } from '@log-book/adapter-claude-code/source-writer'
import { openCodeSourceWriter } from '@log-book/adapter-opencode/source-writer'
import { PROMPT_ACTS } from '@log-book/engine'
import { describe, expect, it } from 'vitest'
import { PLAN_CORPUS } from '../corpus/index.js'
import { MODELS } from '../corpus/models.js'
import { planDataset } from './planner.js'
import { scriptPlan } from './scripts.js'
import type { IPlanInputs, IWriterDeclaration, IWriterScripts } from './types.js'

type TCallStep = Extract<ScriptStep, { kind: 'call' }>

interface IWrittenStep {
  writer: number
  session: string
  step: ScriptStep
}

const ANCHOR = Date.UTC(2026, 8, 28, 18)
const SLOW_MS = 30_000
const SLOW_FACTOR = 10
// The families the slow-call card leaves out: they wait on other work or on the human by design.
const NOT_SLOW = new Set(['subagent', 'dispatch', 'question', 'wait'])

const WRITERS = [claudeCodeSourceWriter(), openCodeSourceWriter()] as const
const DECLARATIONS: readonly IWriterDeclaration[] = [
  { capabilities: [...WRITERS[0].capabilities], families: [...WRITERS[0].families], models: MODELS['claude-code'] },
  { capabilities: [...WRITERS[1].capabilities], families: [...WRITERS[1].families], models: MODELS.opencode },
]

const inputs = (writers: readonly IWriterDeclaration[] = DECLARATIONS, seed = 1): IPlanInputs => ({
  size: 'small',
  seed,
  anchor: ANCHOR,
  labels: 'all',
  model: 'claude-haiku-4-5',
  corpus: PLAN_CORPUS,
  writers,
})

const scriptsFor = (planInputs: IPlanInputs): IWriterScripts[] => scriptPlan(planDataset(planInputs), planInputs)

const sessionSteps = (writer: number, script: ISessionScript): IWrittenStep[] =>
  script.steps.flatMap((step) => [
    { writer, session: script.key, step },
    ...(step.kind === 'spawn' ? sessionSteps(writer, step.child) : []),
  ])

const allSteps = (written: readonly IWriterScripts[]): IWrittenStep[] =>
  written.flatMap((scripts, writer) => scripts.scripts.flatMap((script) => sessionSteps(writer, script)))

const callsOf = (steps: readonly IWrittenStep[]): (IWrittenStep & { step: TCallStep })[] =>
  steps.flatMap((entry) => (entry.step.kind === 'call' ? [{ ...entry, step: entry.step }] : []))

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
const isSlow = (
  call: IWrittenStep & { step: TCallStep },
  calls: readonly (IWrittenStep & { step: TCallStep })[]
): boolean => {
  const usual = median(
    calls
      .filter((other) => other.writer === call.writer && other.step.family === call.step.family)
      .map((other) => durationOf(other.step))
  )
  const duration = durationOf(call.step)
  return (
    !NOT_SLOW.has(call.step.family) && !isScriptedRun(call.step) && duration > SLOW_MS && duration > SLOW_FACTOR * usual
  )
}

const without = (declaration: IWriterDeclaration, item: string): IWriterDeclaration => ({
  ...declaration,
  capabilities: declaration.capabilities.filter((candidate) => candidate !== item),
  families: declaration.families.filter((candidate) => candidate !== item),
})

// The writer's features narrowed to a declaration, for the harness-neutral script check.
const featuresOf = (
  writer: ISourceWriter,
  declaration: IWriterDeclaration | undefined
): Pick<ISourceWriter, 'capabilities' | 'families'> => ({
  capabilities: new Set(SOURCE_CAPABILITIES.filter((capability) => declaration?.capabilities.includes(capability))),
  families: new Set([...writer.families].filter((family) => declaration?.families.includes(family))),
})

describe('the small plan coverage matrix, in its scripts', () => {
  const written = scriptsFor(inputs())
  const steps = allSteps(written)
  const calls = callsOf(steps)
  const replies = steps.flatMap(({ writer, step }) => (step.kind === 'reply' ? [{ writer, step }] : []))

  it('row 4: 1 scripted session in the first writer, started by a claude -p shell call in another, at its time', () => {
    // Arrange
    const scripted = written[0]?.scripts.filter((script) => script.isScripted) ?? []
    const [first] = scripted[0]?.steps ?? []
    const text = first?.kind === 'prompt' ? first.text : ''
    const at = first?.kind === 'prompt' ? first.at : null

    // Act
    const runs = calls.filter(({ step }) => isScriptedRun(step))

    // Assert
    expect({
      scripted: scripted.length,
      runs: runs.map(({ writer, session, step }) => ({
        writer,
        isOtherSession: session !== scripted[0]?.key,
        command: step.input.command,
        startAt: step.startAt,
      })),
    }).toStrictEqual({
      scripted: 1,
      runs: [{ writer: 0, isOtherSession: true, command: `claude -p "${text}"`, startAt: at }],
    })
  })

  it('row 5: model time, tool time, human waits through questions, wait calls and a slow call', () => {
    // Act
    const questions = calls.filter(({ step }) => step.family === 'question')

    // Assert
    expect({
      modelTime: replies.some(({ step }) => step.endAt > step.at),
      toolTime: calls.some(({ step }) => durationOf(step) > 0),
      humanWaits: new Set(questions.filter(({ step }) => durationOf(step) >= SLOW_MS).map(({ writer }) => writer)),
      waits: new Set(calls.filter(({ step }) => step.family === 'wait').map(({ writer }) => writer)),
      slow: calls.some((call) => isSlow(call, calls)),
    }).toStrictEqual({
      modelTime: true,
      toolTime: true,
      humanWaits: new Set([0, 1]),
      waits: new Set([0, 1]),
      slow: true,
    })
  })

  it('row 6: 3 models in the first writer, 2 in the second, cache and reasoning tokens, and cost in the second', () => {
    // Act
    const modelsOf = (writer: number): Set<string> =>
      new Set(replies.filter((reply) => reply.writer === writer).map(({ step }) => step.model))

    // Assert
    expect({
      models: [modelsOf(0).size, modelsOf(1).size],
      cacheRead: replies.some(({ step }) => (step.tokens?.cacheRead ?? 0) > 0),
      cacheWrite: replies.some(({ step }) => (step.tokens?.cacheWrite ?? 0) > 0),
      reasoning: replies.some(({ step }) => (step.tokens?.reasoning ?? 0) > 0),
      costs: [
        replies.some(({ writer, step }) => writer === 0 && step.cost !== null),
        replies.filter(({ writer }) => writer === 1).every(({ step }) => step.cost !== null),
      ],
    }).toStrictEqual({ models: [3, 2], cacheRead: true, cacheWrite: true, reasoning: true, costs: [false, true] })
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

  it('row 8: 1 session in the first writer with tools offered, the calendar server failing, and tools loaded', () => {
    // Act
    const sessions = [0, 1].map((writer) => {
      const events = steps.filter((entry) => entry.writer === writer && entry.step.kind === 'event')
      const offered = events.flatMap(({ session, step }) =>
        step.kind === 'event' && step.event.type === 'tools-offered' ? [{ session, event: step.event }] : []
      )
      const loaded = events.filter(({ step }) => step.kind === 'event' && step.event.type === 'tools-loaded')
      return offered.map(({ session, event }) => ({
        failed: event.failedServers.map((server) => server.name),
        isLoadedThere: loaded.some((entry) => entry.session === session),
      }))
    })

    // Assert
    expect(sessions).toStrictEqual([[{ failed: ['calendar'], isLoadedThere: true }], []])
  })

  it('row 9: the write-release-notes skill in one writer and review-checklist in the other', () => {
    // Act
    const skills = [0, 1].map(
      (writer) =>
        new Set(
          steps.flatMap((entry) => (entry.writer === writer && entry.step.kind === 'skill' ? [entry.step.name] : []))
        )
    )

    // Assert
    expect(skills).toStrictEqual([new Set(['review-checklist']), new Set(['write-release-notes'])])
  })

  it('row 10: /review with its file and /model built in typed in the first writer, release-notes as a template in the second', () => {
    // Act
    const commands = [0, 1].map((writer) =>
      steps.flatMap((entry) =>
        entry.writer === writer && entry.step.kind === 'command'
          ? [{ name: entry.step.name, isTyped: entry.step.body === null }]
          : []
      )
    )
    const files = written.map((scripts) => scripts.commandFiles.map((file) => [file.name, file.projectDir]))
    const template = steps.find(({ step }) => step.kind === 'command' && step.body !== null)?.step

    // Assert
    expect({
      first: commands[0]?.toSorted((left, right) => (left.name < right.name ? -1 : 1)),
      second: commands[1],
      files,
      templateBody: template?.kind === 'command' ? template.body : null,
    }).toStrictEqual({
      first: [
        { name: 'model', isTyped: true },
        { name: 'review', isTyped: true },
      ],
      second: [{ name: 'release-notes', isTyped: false }],
      files: [
        [
          ['review', null],
          ['release-notes', null],
        ],
        [['release-notes', null]],
      ],
      templateBody: PLAN_CORPUS.commands.files['release-notes'].commandFile,
    })
  })

  it('row 15, its act part: every act on at least one prompt, and an act for every prompt', () => {
    // Act
    const prompts = steps.filter(({ step }) => step.kind === 'prompt')
    const acts = written.flatMap((scripts) => Object.values(scripts.acts))

    // Assert
    expect({
      acts: PROMPT_ACTS.filter((act) => acts.includes(act)),
      tagged: prompts.every(({ writer, step }) => written[writer]?.acts[step.key] !== undefined),
    }).toStrictEqual({ acts: [...PROMPT_ACTS], tagged: true })
  })

  it('row 21, its last part: a search phrase in exactly one tool output and nowhere else', () => {
    // Arrange
    const phrase = PLAN_CORPUS.tools.searchPhrase

    // Act
    const outputs = calls.filter(({ step }) => step.result?.includes(phrase) === true)
    const texts = steps.filter(
      ({ step }) => (step.kind === 'prompt' || step.kind === 'reply') && step.text?.includes(phrase) === true
    )

    // Assert
    expect({ outputs: outputs.length, texts: texts.length }).toStrictEqual({ outputs: 1, texts: 0 })
  })
})

describe('scriptPlan', () => {
  it.each(WRITERS.map((writer, index) => [index, writer] as const))(
    'gives writer %i command files and scripts it writes in an empty home, refusing none',
    async (index, writer) => {
      // Arrange
      const scripts = scriptsFor(inputs())[index]
      const home = await mkdtemp(join(tmpdir(), 'demo-scripts-'))

      try {
        // Act
        const commandFiles = await writer.writeCommandFiles(home, scripts?.commandFiles ?? [])
        const written = await writer.writeSessions(home, scripts?.scripts ?? [])

        // Assert
        expect({
          commandFiles: commandFiles.length,
          sessions: (scripts?.scripts ?? []).every((script) => written.ids.has(script.key)),
        }).toStrictEqual({ commandFiles: scripts?.commandFiles.length, sessions: true })
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }
  )

  it('names a tool only on mcp and other calls, and on no dispatch call', () => {
    // Act
    const calls = callsOf(allSteps(scriptsFor(inputs())))

    // Assert
    expect({
      named: new Set(calls.filter(({ step }) => step.tool !== null).map(({ step }) => step.family)),
      dispatch: calls.filter(({ step }) => step.family === 'dispatch').map(({ step }) => step.tool),
    }).toStrictEqual({ named: new Set(['mcp', 'other']), dispatch: [null, null] })
  })

  it('gives equal scripts for equal inputs, which read back from JSON as an equal value', () => {
    // Act
    const [first, second] = [scriptsFor(inputs()), scriptsFor(inputs())]

    // Assert
    expect({ isEqual: first, readBack: JSON.parse(JSON.stringify(first)) as unknown }).toStrictEqual({
      isEqual: second,
      readBack: first,
    })
  })

  it.each([7, 21])('keeps every script to the contract rules for seed %i', (seed) => {
    // Arrange
    const written = scriptsFor(inputs(DECLARATIONS, seed))

    // Act
    const check = (): void => {
      WRITERS.forEach((writer, index) => {
        checkScripts(writer, written[index]?.scripts ?? [], [])
      })
    }

    // Assert
    expect(check).not.toThrow()
  })

  it.each([...new Set([...SOURCE_CAPABILITIES, ...DECLARATIONS.flatMap((declaration) => declaration.families)])])(
    'gives no step that needs %s to writers that leave it out',
    (item) => {
      // Arrange
      const writers = DECLARATIONS.map((declaration) => without(declaration, item))
      const written = scriptsFor(inputs(writers))

      // Act
      const check = (): void => {
        WRITERS.forEach((writer, index) => {
          checkScripts(featuresOf(writer, writers[index]), written[index]?.scripts ?? [], [])
        })
      }

      // Assert
      expect(check).not.toThrow()
    }
  )
})
