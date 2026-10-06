import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { openSqlite } from '@log-book/core'
import { installFakeClaude, type IFakeClaude, type IFakeClaudeScenario } from '@log-book/engine/testing'
import { describe, expect, inject, it } from 'vitest'
import { lineDifferences, useE2eHarness, type IE2eHome } from './harness.js'

// Labelling through the binary with the recorded claude fake first on the sealed PATH, which holds no other claude:
// the model each call carries, exits 7 and 8, and what labels plan and labels preview print.
const harness = useE2eHarness()

// Asserted as literals, never read from the engine's constants.
const DEFAULT_MODEL = 'claude-haiku-4-5'
const CHOSEN_MODEL = 'claude-sonnet-5-5'
const NOT_FOUND = 'needs Claude Code: install it (https://claude.com/claude-code) or set CLAUDE_BIN'
const SIGNED_OUT = 'Claude Code is not signed in. Run claude, sign in, then run this again.'
const FRAMING_NOTE =
  'Claude Code adds framing of its own to each request (its version, the folder it runs in, your platform, the date and ' +
  'the account it is logged in with), which Log Book does not see and so cannot show.'
const PLAN_FIELDS = [
  'model',
  'claudeVersion',
  'authMethod',
  'apiProvider',
  'apiKeyInEnvironment',
  'tasks',
  'harnesses',
  'records',
  'estimatedInputTokens',
]
// The labels the prompt task writes: the act of each prompt, and the developer's reactions it carries.
const PROMPT_LABELS = new Set(['act', 'reaction', 'about', 'target', 'reach', 'steps'])

// Each task's batch, by its system line and, for the four tasks that share one, the code table its prompt holds.
const TASKS = [
  { task: 'shell', system: 'You label shell commands', includes: undefined, answer: '0 0' },
  { task: 'tool-failure', system: 'You label failed tool calls', includes: undefined, answer: '0' },
  { task: 'session', system: 'You label conversations', includes: 'secondGoal codes:', answer: '0 0 | added a field' },
  { task: 'outcome', system: 'You label conversations', includes: 'outcome codes:', answer: '0 | done' },
  { task: 'prompt', system: 'You label conversations', includes: 'act codes:', answer: '0' },
  { task: 'reply', system: 'You label conversations', includes: 'reply codes:', answer: '0 | -' },
] as const

const ANSWERS: IFakeClaudeScenario['answers'] = TASKS.map(({ system, includes, answer }) => ({
  systemPrompt: system,
  answer,
  ...(includes === undefined ? {} : { promptIncludes: includes }),
}))

interface IPlanFacts {
  tasks: { task: string; records: number }[]
  records: number
}

// A copy of the small home with no warehouse, synced once, so every record waits for a model label.
const syncedHome = async (): Promise<IE2eHome> => {
  const home = await harness.createHome()
  const sync = await harness.run(home, ['sync'])
  if (sync.code !== 0) {
    throw new Error(`logbook sync exited ${String(sync.code)}: ${sync.stderr.join(' | ')}`)
  }
  return home
}

const fakeIn = async (
  home: IE2eHome,
  scenario: IFakeClaudeScenario = {}
): Promise<{ fake: IFakeClaude; bin: string }> => {
  const bin = join(home.out, 'claude-bin')
  await mkdir(bin)
  return { fake: await installFakeClaude(bin, { answers: ANSWERS, ...scenario }), bin }
}

const query = async <TRow>(home: IE2eHome, sql: string): Promise<TRow[]> => {
  const db = await openSqlite(home.environment.LOGBOOK_DB ?? '', { isReadOnly: true })
  try {
    return (db.prepare(sql).all() as object[]).map((row) => ({ ...row }) as TRow)
  } finally {
    db.close()
  }
}

const newestRun = async (home: IE2eHome): Promise<{ id: number; model: string; outcome: string } | undefined> =>
  (
    await query<{ id: number; model: string; outcome: string }>(
      home,
      'SELECT id, model, outcome FROM label_run ORDER BY id DESC LIMIT 1'
    )
  )[0]

const labelRuns = async (home: IE2eHome): Promise<number> =>
  (await query<{ runs: number }>(home, 'SELECT count(*) AS runs FROM label_run'))[0]?.runs ?? 0

// The task a recorded labelling call belongs to.
const taskOf = (argv: readonly string[], stdin: string): string | undefined => {
  const system = argv[argv.indexOf('--system-prompt') + 1] ?? ''
  return TASKS.find(
    (task) => system.startsWith(task.system) && (task.includes === undefined || stdin.includes(task.includes))
  )?.task
}

const labellingCalls = async (fake: IFakeClaude): Promise<{ model: string | null; task: string | undefined }[]> =>
  (await fake.readRecords())
    .filter((record) => record.argv.includes('-p'))
    .map((record) => ({ model: record.model, task: taskOf(record.argv, record.stdin) }))

// A prompt of an interactive session of the small set, short enough to survive the flattening of its text.
const markedPrompt = (): string => {
  const scripts = inject('e2eDemo').plan.writers.flatMap((writer) => writer.scripts)
  const prompt = scripts
    .filter((script) => !script.isScripted)
    .flatMap((script) => script.steps)
    .find((step) => step.kind === 'prompt' && step.text.length >= 20 && !step.text.includes('\n'))
  if (prompt?.kind !== 'prompt') {
    throw new Error('the small set has no single-line prompt in an interactive session')
  }
  return prompt.text.slice(0, 20)
}

describe('labelling through the binary', () => {
  it('plans with only the version and sign-in calls, then labels every task on claude-haiku-4-5 by default', async () => {
    // Arrange
    const home = await syncedHome()
    const { fake, bin } = await fakeIn(home)

    // Act
    const plan = await harness.run(home, ['labels', 'plan'], { firstOnPath: bin })
    const callsWhilePlanning = (await fake.readRecords()).map((record) => record.argv)
    const update = await harness.run(home, ['labels', 'update'], { firstOnPath: bin })

    // Assert
    const facts = JSON.parse(plan.stdout.join('\n')) as IPlanFacts & Record<string, unknown>
    const calls = await labellingCalls(fake)
    expect({
      plan: { code: plan.code, lines: plan.stdout.length, fields: Object.keys(facts) },
      callsWhilePlanning,
      update: {
        code: update.code,
        stdout: lineDifferences(update.stdout, [
          `Labelled ${facts.records.toLocaleString('en-US')} records in {duration}.`,
        ]),
      },
      models: [...new Set(calls.map(({ model }) => model))],
      tasks: [...new Set(calls.map(({ task }) => task ?? 'none'))].toSorted(),
      run: await newestRun(home),
      labellers: (
        await query<{ labeller: string }>(home, "SELECT DISTINCT labeller FROM label WHERE labeller <> 'rules'")
      ).map(({ labeller }) => labeller),
    }).toStrictEqual({
      plan: { code: 0, lines: 1, fields: PLAN_FIELDS },
      callsWhilePlanning: [['--version'], ['auth', 'status', '--json']],
      update: { code: 0, stdout: [] },
      models: [DEFAULT_MODEL],
      tasks: facts.tasks
        .filter(({ records }) => records > 0)
        .map(({ task }) => task)
        .toSorted(),
      run: { id: expect.any(Number) as number, model: DEFAULT_MODEL, outcome: 'ok' },
      labellers: [DEFAULT_MODEL],
    })
  })

  it('runs one task on the model chosen, keeping the labels of the default model', async () => {
    // Arrange
    const home = await syncedHome()
    const { fake, bin } = await fakeIn(home)
    await harness.run(home, ['labels', 'update'], { firstOnPath: bin })
    const callsBefore = (await labellingCalls(fake)).length
    const countSql = `SELECT count(*) AS labels FROM label WHERE labeller = '${DEFAULT_MODEL}'`
    const defaultLabels = await query<{ labels: number }>(home, countSql)

    // Act
    const run = await harness.run(home, ['labels', 'run', '--task', 'prompt', '--model', CHOSEN_MODEL], {
      firstOnPath: bin,
    })

    // Assert
    const chosen = await query<{ name: string; recordType: string }>(
      home,
      `SELECT DISTINCT name, record_type AS recordType FROM label WHERE labeller = '${CHOSEN_MODEL}'`
    )
    expect({
      code: run.code,
      models: [...new Set((await labellingCalls(fake)).slice(callsBefore).map(({ model }) => model))],
      run: await newestRun(home),
      isPromptOnly: chosen.length > 0 && chosen.every(({ name }) => PROMPT_LABELS.has(name)),
      defaultLabels: await query<{ labels: number }>(home, countSql),
    }).toStrictEqual({
      code: 0,
      models: [CHOSEN_MODEL],
      run: { id: expect.any(Number) as number, model: CHOSEN_MODEL, outcome: 'ok' },
      isPromptOnly: true,
      defaultLabels,
    })
  })

  it('exits 8 at the usage limit, keeping as many labels as the run says it did', async () => {
    // Arrange
    const home = await syncedHome()
    const { bin } = await fakeIn(home, {
      rules: [{ marker: markedPrompt(), kind: 'envelope', envelope: 'usage-limit' }],
    })

    // Act
    const run = await harness.run(home, ['labels', 'run', '--task', 'prompt'], { firstOnPath: bin })

    // Assert
    const newest = await newestRun(home)
    const [task] = await query<{ done: number }>(
      home,
      `SELECT done FROM label_run_task WHERE run_id = ${String(newest?.id ?? 0)} AND task = 'prompt'`
    )
    const [labelled] = await query<{ records: number }>(
      home,
      `SELECT count(*) AS records FROM label WHERE labeller = '${DEFAULT_MODEL}' AND name = 'act'`
    )
    expect({
      code: run.code,
      isLimitLine: run.stdout[0]?.startsWith('Stopped at your Claude usage limit (') === true,
      outcome: newest?.outcome,
      labelled: labelled?.records,
    }).toStrictEqual({ code: 8, isLimitLine: true, outcome: 'limit', labelled: task?.done })
  })

  it('exits 7 when no claude is on the PATH, recording no run', async () => {
    // Arrange
    const home = await syncedHome()

    // Act
    const update = await harness.run(home, ['labels', 'update'])

    // Assert
    expect({ code: update.code, last: update.stderr.at(-1), runs: await labelRuns(home) }).toStrictEqual({
      code: 7,
      last: NOT_FOUND,
      runs: 0,
    })
  })

  it('exits 7 when Claude Code is signed out, printing no plan and sending nothing', async () => {
    // Arrange
    const home = await syncedHome()
    const { fake, bin } = await fakeIn(home, { auth: { loggedIn: false } })

    // Act
    const plan = await harness.run(home, ['labels', 'plan'], { firstOnPath: bin })

    // Assert
    expect({
      code: plan.code,
      stdout: plan.stdout,
      last: plan.stderr.at(-1),
      calls: (await labellingCalls(fake)).length,
    }).toStrictEqual({ code: 7, stdout: [], last: SIGNED_OUT, calls: 0 })
  })

  it('previews the next shell batch with no claude, taking no lock and recording no run', async () => {
    // Arrange
    const home = await syncedHome()

    // Act
    const preview = await harness.run(home, ['labels', 'preview', '--task', 'shell'])

    // Assert
    const [first = ''] = preview.stdout
    const records =
      /^Preview of task shell: the next 1 batch, (?<records>[\d,]+ records?), exactly as labelling would send it now\. Nothing is sent\.$/u.exec(
        first
      )?.groups?.records
    expect({
      code: preview.code,
      first: records !== undefined,
      heading: preview.stdout.slice(1, 3),
      batch: preview.stdout.includes(`Batch 1 of 1 (sent on the stdin of one claude -p call, ${records ?? ''}):`),
      closing: preview.stdout.slice(-2),
      isLock: existsSync(`${home.environment.LOGBOOK_DB ?? ''}.labels.lock`),
      runs: await labelRuns(home),
    }).toStrictEqual({
      code: 0,
      first: true,
      heading: ['', 'System line (passed to claude as --system-prompt):'],
      batch: true,
      closing: ['', FRAMING_NOTE],
      isLock: false,
      runs: 0,
    })
  })
})
