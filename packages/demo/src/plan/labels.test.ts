import { claudeCodeSourceWriter } from '@log-book/adapter-claude-code/source-writer'
import { openCodeSourceWriter } from '@log-book/adapter-opencode/source-writer'
import { LogBookError } from '@log-book/core'
import { DEFAULT_LABEL_MODEL, LABEL_TASK_NAMES, LABEL_TASKS } from '@log-book/engine'
import { describe, expect, it } from 'vitest'
import { PLAN_CORPUS } from '../corpus/index.js'
import { MODELS } from '../corpus/models.js'
import { DEMO_ERROR_CODES } from '../errors.js'
import { HOUR_MS, MINUTE_MS } from './calendar.js'
import { indexRecords } from './label-records.js'
import { planLabels } from './labels.js'
import { planDataset } from './planner.js'
import { scriptPlan } from './scripts.js'
import type { ILabelPlan, IPlan, IPlanInputs, IPlannedLabel, IWriterDeclaration, IWriterScripts } from './types.js'
import { validateLabelPlan } from './validate.js'

interface IBuilt {
  plan: IPlan
  scripts: IWriterScripts[]
  labels: ILabelPlan
}

const ANCHOR = Date.UTC(2026, 8, 28, 18)
// What a refusal names: the record key and the field, before the reason.
const NAMED = /^(?<named>Plan record .+, field [^:]+):/u
const WRITERS = [claudeCodeSourceWriter(), openCodeSourceWriter()] as const
const DECLARATIONS: readonly IWriterDeclaration[] = [
  { capabilities: [...WRITERS[0].capabilities], families: [...WRITERS[0].families], models: MODELS['claude-code'] },
  { capabilities: [...WRITERS[1].capabilities], families: [...WRITERS[1].families], models: MODELS.opencode },
]

const inputs = (fields: Partial<IPlanInputs> = {}): IPlanInputs => ({
  size: 'small',
  seed: 1,
  anchor: ANCHOR,
  labels: 'all',
  model: null,
  corpus: PLAN_CORPUS,
  writers: DECLARATIONS,
  ...fields,
})

const build = (fields: Partial<IPlanInputs> = {}): IBuilt => {
  const planInputs = inputs(fields)
  const plan = planDataset(planInputs)
  const scripts = scriptPlan(plan, planInputs)
  return { plan, scripts, labels: planLabels(plan, scripts, PLAN_CORPUS) }
}

// The code and the record key and field a refused plan names, or null when it is accepted.
const refusalOf = (built: IBuilt, labels: ILabelPlan): { code: string; named: string } | null => {
  try {
    validateLabelPlan(built.plan, built.scripts, labels)
    return null
  } catch (error) {
    if (!(error instanceof LogBookError)) {
      throw error
    }
    return { code: error.code, named: NAMED.exec(error.message)?.groups?.named ?? error.message }
  }
}

const refusal = (key: string, field: string): { code: string; named: string } => ({
  code: DEMO_ERROR_CODES.DEMO_PLAN_INVALID,
  named: `Plan record ${key}, field ${field}`,
})

const withLabels = (labels: ILabelPlan, change: (label: IPlannedLabel) => IPlannedLabel | null): ILabelPlan => ({
  ...labels,
  labels: labels.labels.flatMap((label) => change(label) ?? []),
})

const firstLabel = (labels: ILabelPlan, test: (label: IPlannedLabel) => boolean): IPlannedLabel => {
  const found = labels.labels.find(test)
  if (found === undefined) {
    throw new Error('The plan holds no such label')
  }
  return found
}

// The runs with each one's shell count moved by the given amount, planned and done alike.
const shiftedShellCounts = (labels: ILabelPlan, shifts: Readonly<Record<number, number>>): ILabelPlan['runs'] =>
  labels.runs.map((run) => ({
    ...run,
    tasks: run.tasks.map((task) => {
      const shift = task.task === 'shell' ? (shifts[run.number] ?? 0) : 0
      return { ...task, planned: task.planned + shift, done: task.done + shift }
    }),
  }))

const taskOf = (label: IPlannedLabel): string | undefined =>
  LABEL_TASKS.find((task) =>
    task.fields.some((field) => field.name === label.name && field.recordType === label.recordType)
  )?.name

const isRecent = (plan: IPlan, session: string | undefined): boolean =>
  (plan.sessions.find((planned) => planned.key === session)?.end ?? 0) > plan.anchor - 48 * HOUR_MS

describe('the small plan coverage matrix, in its labels', () => {
  const built = build()
  const index = indexRecords(built.plan, built.scripts)
  const sessionOfCall = (key: string): string | undefined => index.shellCalls.get(key) ?? index.failedCalls.get(key)

  it('row 18: the 2 sessions of the last 48 hours get no model label', () => {
    // Arrange
    const recent = built.plan.sessions.filter(
      (session) => session.parentKey === null && isRecent(built.plan, session.key)
    )

    // Act
    const labelled = built.labels.labels.filter((label) => {
      const base = label.recordKey.split('#')[0] ?? ''
      const session =
        sessionOfCall(base) ?? index.prompts.get(base)?.session ?? index.replies.get(base)?.session ?? base
      return isRecent(built.plan, session)
    })

    // Assert
    expect({ recent: recent.length, labelled: labelled.length }).toStrictEqual({ recent: 2, labelled: 0 })
  })

  it('row 19: 20 shell calls and 2 prompts with their replies labelled again later by the second model', () => {
    // Act
    const later = (run: number, recordType: string): Set<string> =>
      new Set(
        built.labels.labels
          .filter((label) => label.run === run && label.recordType === recordType)
          .map((label) => label.recordKey)
      )
    const prompts = [...later(3, 'message')]
    const replies = later(4, 'message')

    // Assert
    expect({
      labellers: new Set(built.labels.labels.filter((label) => label.run > 1).map((label) => label.labeller)),
      shell: later(2, 'tool_call').size,
      prompts: prompts.length,
      reactions: later(3, 'reaction').size > 0,
      isTheirReplies: prompts.every((prompt) => replies.has(index.prompts.get(prompt)?.reply ?? '')),
      replies: replies.size,
    }).toStrictEqual({
      labellers: new Set(['claude-sonnet-5-5']),
      shell: 20,
      prompts: 2,
      reactions: true,
      isTheirReplies: true,
      replies: 2,
    })
  })

  it('row 24: 4 labelling runs as the commands that made them, one after another before the anchor', () => {
    // Act
    const runs = built.labels.runs.map(({ tasks, ...run }) => ({
      ...run,
      startedAt: run.startedAt - ANCHOR,
      endedAt: run.endedAt - ANCHOR,
      tasks: tasks.map(({ task, planned, done }) => [task, planned === done && done >= 0]),
    }))

    // Assert
    const start = -47 * HOUR_MS
    const end = start + 30 * MINUTE_MS
    expect(runs).toStrictEqual([
      {
        number: 1,
        command: 'logbook labels update',
        model: 'claude-haiku-4-5',
        pid: 40_001,
        startedAt: start,
        endedAt: end,
        outcome: 'ok',
        error: null,
        tasks: LABEL_TASK_NAMES.map((task) => [task, true]),
      },
      ...(['shell', 'prompt', 'reply'] as const).map((task, sampleIndex) => ({
        number: sampleIndex + 2,
        command: `logbook labels run --task ${task} --sample ${task === 'shell' ? '20' : '2'} --model claude-sonnet-5-5`,
        model: 'claude-sonnet-5-5',
        pid: 40_002 + sampleIndex,
        startedAt: end + HOUR_MS + sampleIndex * 5 * MINUTE_MS,
        endedAt: end + HOUR_MS + (sampleIndex + 1) * 5 * MINUTE_MS,
        outcome: 'ok',
        error: null,
        tasks: [[task, true]],
      })),
    ])
  })

  it('labels something in every task of run 1, so readers see that labelling ran', () => {
    // Act
    const done = built.labels.runs[0]?.tasks.map((task) => task.done > 0)

    // Assert
    expect(done).toStrictEqual(LABEL_TASK_NAMES.map(() => true))
  })
})

describe('planLabels', () => {
  it.each([1, 7, 21])('plans labels the validation accepts for seed %i', (seed) => {
    // Arrange
    const built = build({ seed })

    // Act
    const refused = refusalOf(built, built.labels)

    // Assert
    expect(refused).toBeNull()
  })

  it("gives every label and every run task the engine's current version of its task", () => {
    // Arrange
    const { labels } = build()
    const versions = new Map(LABEL_TASKS.map((task) => [task.name, task.version]))
    // Act
    const wrong = [
      ...labels.labels.filter((label) => versions.get(taskOf(label) as never) !== label.version),
      ...labels.runs.flatMap((run) => run.tasks.filter((task) => versions.get(task.task) !== task.version)),
    ]

    // Assert
    expect(wrong).toStrictEqual([])
  })

  it("labels with the engine's default model without one, and the second model's sample with claude-sonnet-5-5", () => {
    // Act
    const { labels } = build({ model: null })

    // Assert
    expect({
      first: new Set(labels.labels.filter((label) => label.run === 1).map((label) => label.labeller)),
      sample: new Set(labels.labels.filter((label) => label.run > 1).map((label) => label.labeller)),
    }).toStrictEqual({ first: new Set([DEFAULT_LABEL_MODEL]), sample: new Set(['claude-sonnet-5-5']) })
  })

  it('labels with claude-sonnet-5-5 when asked, and the sample with claude-haiku-4-5', () => {
    // Act
    const { labels } = build({ model: 'claude-sonnet-5-5' })

    // Assert
    expect({
      first: new Set(labels.labels.filter((label) => label.run === 1).map((label) => label.labeller)),
      sample: new Set(labels.labels.filter((label) => label.run > 1).map((label) => label.labeller)),
    }).toStrictEqual({ first: new Set(['claude-sonnet-5-5']), sample: new Set(['claude-haiku-4-5']) })
  })

  it.each(['claude haiku', '-x'])('refuses the model %j before anything is planned', (model) => {
    // Act
    const plan = (): IPlan => planDataset(inputs({ model }))

    // Assert
    expect(plan).toThrow(expect.objectContaining({ code: DEMO_ERROR_CODES.DEMO_PLAN_INVALID }))
  })

  it('plans no label and no run with the labels variant none', () => {
    // Act
    const { labels } = build({ labels: 'none' })

    // Assert
    expect(labels).toStrictEqual({ labels: [], runs: [] })
  })
})

describe('validateLabelPlan', () => {
  const built = build()
  const { labels, plan } = built
  const index = indexRecords(built.plan, built.scripts)
  const shell = firstLabel(labels, (label) => label.run === 1 && label.name === 'purpose')
  const summary = firstLabel(labels, (label) => label.name === 'summary')
  const quote = firstLabel(labels, (label) => label.name === 'replyQuote')
  const steps = firstLabel(labels, (label) => label.name === 'steps')
  const reply = firstLabel(labels, (label) => label.run === 1 && label.name === 'reply')
  const single = [...index.prompts.keys()].find(
    (prompt) =>
      labels.labels.some((label) => label.recordKey === `${prompt}#1`) &&
      !labels.labels.some((label) => label.recordKey === `${prompt}#2`)
  )
  const recentCall = [...index.shellCalls].find(([, session]) => isRecent(plan, session))?.[0] ?? ''
  const otherCall = [...index.shellCalls.keys()].find(
    (key) => key !== shell.recordKey && !key.startsWith(steps.recordKey.split(':')[0] ?? '')
  )
  const [first] = labels.runs
  const recent = plan.sessions.find(
    (session) => session.parentKey === null && isRecent(plan, session.key) && session.end < plan.anchor - HOUR_MS
  )

  const moved = (to: string, run: number): ILabelPlan =>
    withLabels(labels, (label) =>
      label.recordKey === shell.recordKey && label.run === 1
        ? { ...label, recordKey: to, run, labeller: labels.runs[run - 1]?.model ?? '' }
        : label
    )

  it.each([
    [
      'Fields: a field no task writes',
      () => withLabels(labels, (label) => (label === shell ? { ...label, name: 'mood' } : label)),
      refusal(shell.recordKey, 'mood'),
    ],
    [
      'Fields: a field the task always writes left out',
      () =>
        withLabels(labels, (label) =>
          label.recordKey === shell.recordKey && label.run === 1 && label.name === 'failure' ? null : label
        ),
      refusal(shell.recordKey, 'failure'),
    ],
    [
      "Values: a value outside the engine's vocabulary",
      () => withLabels(labels, (label) => (label === shell ? { ...label, value: 'guessing' } : label)),
      refusal(shell.recordKey, 'purpose'),
    ],
    [
      'Texts: a summary over 200 characters',
      () => withLabels(labels, (label) => (label === summary ? { ...label, value: 'x'.repeat(201) } : label)),
      refusal(summary.recordKey, 'summary'),
    ],
    [
      'Texts: a quote over 15 words',
      () =>
        withLabels(labels, (label) =>
          label === quote ? { ...label, value: Array.from({ length: 16 }, () => 'word').join(' ') } : label
        ),
      refusal(quote.recordKey, 'replyQuote'),
    ],
    [
      'Texts: a quote not in its reply',
      () => withLabels(labels, (label) => (label === quote ? { ...label, value: 'not in the reply' } : label)),
      refusal(quote.recordKey, 'replyQuote'),
    ],
    [
      'Targets: shell labels on a record that is no shell call',
      () => moved(reply.recordKey, 1),
      refusal(reply.recordKey, 'purpose'),
    ],
    [
      'Reactions: a gap in the numbers',
      () =>
        withLabels(labels, (label) =>
          label.recordKey === `${String(single)}#1` ? { ...label, recordKey: `${String(single)}#2` } : label
        ),
      refusal(`${String(single)}#1`, 'reaction'),
    ],
    [
      'Reactions: a step that is no call of the turn before',
      () => withLabels(labels, (label) => (label === steps ? { ...label, value: String(otherCall) } : label)),
      refusal(steps.recordKey, 'steps'),
    ],
    [
      'Model: a labelling model that is no model id',
      () => ({
        ...labels,
        runs: labels.runs.map((run) => (run.number === 1 ? { ...run, model: 'claude haiku' } : run)),
      }),
      refusal('run 1', 'model'),
    ],
    [
      'Model: a second model equal to the labelling model',
      () => ({
        ...labels,
        runs: labels.runs.map((run) => (run.number === 2 ? { ...run, model: first?.model ?? '' } : run)),
      }),
      refusal('run 2', 'model'),
    ],
    [
      'Runs: a planned count unequal to the records labelled',
      () => ({
        ...labels,
        runs: labels.runs.map((run) =>
          run.number === 1
            ? {
                ...run,
                tasks: run.tasks.map((task) => (task.task === 'shell' ? { ...task, planned: task.planned + 1 } : task)),
              }
            : run
        ),
      }),
      refusal('run 1', 'shell planned'),
    ],
    [
      'Runs: a later run labelling a record run 1 did not',
      () => ({ ...moved(recentCall, 2), runs: shiftedShellCounts(labels, { 1: -1, 2: 1 }) }),
      refusal(recentCall, 'purpose'),
    ],
    [
      'Time: a label written outside its run',
      () =>
        withLabels(labels, (label) => (label === shell ? { ...label, labelledAt: (first?.endedAt ?? 0) + 1 } : label)),
      refusal(shell.recordKey, 'purpose'),
    ],
    [
      'Time: a run that ends after the anchor',
      () => ({
        ...labels,
        runs: labels.runs.map((run) => (run.number === 4 ? { ...run, endedAt: plan.anchor + 1 } : run)),
      }),
      refusal('run 4', 'endedAt'),
    ],
    [
      'Time: a session that runs in the hour before run 1',
      () => {
        const startedAt = (recent?.start ?? 0) + 30 * MINUTE_MS
        const shift = startedAt - (first?.startedAt ?? 0)
        return {
          labels: labels.labels.map((label) =>
            label.run === 1 ? { ...label, labelledAt: label.labelledAt + shift } : label
          ),
          runs: labels.runs.map((run) =>
            run.number === 1 ? { ...run, startedAt: run.startedAt + shift, endedAt: run.endedAt + shift } : run
          ),
        }
      },
      refusal(recent?.key ?? '', 'labelledAt'),
    ],
    [
      'Time: a model label on a session that ends after run 1 starts',
      () => ({
        labels: [
          ...labels.labels,
          ...labels.labels
            .filter((label) => label.recordKey === shell.recordKey && label.run === 1)
            .map((label) => ({ ...label, recordKey: recentCall })),
        ],
        runs: shiftedShellCounts(labels, { 1: 1 }),
      }),
      refusal(recentCall, 'purpose'),
    ],
  ])('refuses a plan that breaks the rule %s, naming the record key and the field', (_rule, broken, expected) => {
    // Act
    const refused = refusalOf(built, broken())

    // Assert
    expect(refused).toStrictEqual(expected)
  })
})
