import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { request, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isProcessAlive, takeLabelsLock, type IHeldLock, type LabelsLockOperation } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { logbookStub, type ILogbookStub } from '../src/lib/testing/logbook-stub'
import { mountBuiltHandler, type IBuiltHandler } from './built-handler'

const MINUTE = 60_000
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' }
const REFRESH = '<meta http-equiv="refresh" content="5">'
const UPDATED = 'Log Book was updated while running. Press Ctrl+C and start logbook again.'
const NEEDS_CLAUDE = 'needs Claude Code: install it (https://claude.com/claude-code) or set CLAUDE_BIN'
// Invented counts, in the shape `logbook labels plan` prints.
const PLAN = {
  model: 'claude-haiku-4-5',
  claudeVersion: '2.1.290',
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  apiKeyInEnvironment: false,
  tasks: [
    { task: 'shell', records: 2140 },
    { task: 'tool-failure', records: 0 },
    { task: 'session', records: 12 },
    { task: 'outcome', records: 9 },
    { task: 'prompt', records: 31 },
    { task: 'reply', records: 22 },
  ],
  harnesses: [
    { id: 'example', name: 'Example Harness', records: 1630 },
    { id: 'sample', name: 'Sample Harness', records: 584 },
  ],
  records: 2214,
  estimatedInputTokens: 560_000,
}
const SESSION = {
  id: 'example:demo-0001',
  harness: 'example',
  source_id: 'demo-0001',
  origin: 'interactive',
  is_scripted: 0,
  title: 'Rename the release script',
  started_at: 1_791_100_800_000,
  ended_at: 1_791_100_860_000,
}

interface IApp {
  warehouse: ITestWarehouse
  built: IBuiltHandler
  stub: ILogbookStub
  directory: string
}

interface IReply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

// Each case runs its own copy of the build, so what one process remembers of its children never reaches another.
let app: IApp | undefined
let holder: ChildProcess | undefined
let held: IHeldLock | undefined

const started = (): IApp => {
  if (app === undefined) {
    throw new Error('The case started no app')
  }
  return app
}

const startApp = async (): Promise<IApp> => {
  const warehouse = await createTestWarehouse()
  insert(warehouse.db, 'session', SESSION)
  const directory = await mkdtemp(join(tmpdir(), 'web-labels-'))
  vi.stubEnv('LOGBOOK_DB', warehouse.path)
  const stub = await logbookStub(directory)
  stub.answer(0, [], { stdout: JSON.stringify(PLAN) })
  app = { warehouse, built: await mountBuiltHandler(), stub, directory }
  return app
}

// fetch will not send an Origin header of its own choosing; node:http will.
const send = async (method: string, path: string, headers: Record<string, string> = {}, body = ''): Promise<IReply> =>
  new Promise((resolve, reject) => {
    const outgoing = request(`${started().built.origin}${path}`, { method, headers }, (incoming) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () => {
        resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks).toString() })
      })
    })
    outgoing.on('error', reject)
    outgoing.end(body)
  })

const post = async (path: string, body: string): Promise<IReply> =>
  send('POST', path, { ...FORM, Origin: started().built.origin }, body)

const decode = (html: string): string =>
  html
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')

const textsOf = (body: string, pattern: RegExp): string[] =>
  [...body.matchAll(pattern)].map((match) => decode(match.groups?.text ?? ''))

// /labels as a reader sees it: its part, its lines and what it offers.
interface ILabelsView {
  status: number
  part: string | null
  lastRun: string | null
  lines: string[]
  progress: string[] | null
  model: string | null
  start: string | null
  stop: { isDisabled: boolean } | null
  isReloading: boolean
}

const labelsPage = async (path = '/labels'): Promise<ILabelsView> => {
  const { status, body } = await send('GET', path)
  const stop = /<form method="post" action="\/labels\/stop">[\s\S]*?<\/form>/u.exec(body)?.[0]
  return {
    status,
    part: /data-labels-part="(?<part>[^"]+)"/u.exec(body)?.groups?.part ?? null,
    lastRun: textsOf(body, /<p class="labels__last">(?<text>[^<]*)<\/p>/gu)[0] ?? null,
    lines: textsOf(body, /<p class="labels__line">(?<text>[^<]*)<\/p>/gu),
    progress: textsOf(body, /<pre class="labels__progress">(?<text>[^<]*)<\/pre>/gu)[0]?.split('\n') ?? null,
    model: /name="model" value="(?<model>[^"]*)" required/u.exec(body)?.groups?.model ?? null,
    start:
      decode(
        /<form method="post" action="\/labels">[\s\S]*?title="(?<title>[^"]*)"/u.exec(body)?.groups?.title ?? ''
      ) || null,
    stop: stop === undefined ? null : { isDisabled: /<button[^>]*\sdisabled/u.test(stop) },
    isReloading: body.includes(REFRESH),
  }
}

// The top bar's Label control text on another page.
const topBarLabel = async (): Promise<string | undefined> => {
  const { body } = await send('GET', '/conversations')
  return textsOf(body, /class="top-bar__label-text"[^>]*>(?<text>[^<]*)</gu)[0]?.trim()
}

const runRecord = (pid: number, rest: { endedAgo?: number; outcome?: string } = {}): void => {
  const { warehouse } = started()
  const now = Date.now()
  insert(warehouse.db, 'label_run', {
    pid,
    started_at: now - 4 * MINUTE,
    ended_at: rest.endedAgo === undefined ? null : now - rest.endedAgo,
    outcome: rest.outcome ?? null,
    model: 'claude-haiku-4-5',
  })
  const { id } = warehouse.db.prepare('SELECT MAX(id) AS id FROM label_run').get() as { id: number }
  for (const [task, planned, done] of [
    ['reply', 22, 0],
    ['shell', 2140, 1200],
    ['session', 12, 12],
    ['outcome', 9, 9],
    ['prompt', 31, 19],
    ['tool-failure', 0, 0],
  ] as const) {
    insert(warehouse.db, 'label_run_task', { run_id: id, task, version: 1, planned, done })
  }
}

// A process that is not this app's child holds the lock, taken two minutes before the request.
const lockElsewhere = (operation: LabelsLockOperation): number => {
  holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
  if (holder.pid === undefined) {
    throw new Error('The process that holds the test lock did not start')
  }
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() - 2 * MINUTE)
  try {
    held = takeLabelsLock(started().warehouse.path, operation, { pid: holder.pid })
  } finally {
    vi.useRealTimers()
  }
  return holder.pid
}

const exited = async (pid: number): Promise<void> => {
  await vi.waitFor(() => {
    if (isProcessAlive(pid)) {
      throw new Error(`${String(pid)} still runs`)
    }
  })
}

const PROGRESS = [
  'shell calls    1,200 of 2,140',
  'sessions       12 of 12',
  'outcomes       9 of 9',
  'prompts        19 of 31',
  'replies        0 of 22',
]

afterEach(async () => {
  held?.release()
  held = undefined
  if (holder !== undefined) {
    const gone = once(holder, 'exit')
    holder.kill()
    await gone
    holder = undefined
  }
  if (app !== undefined) {
    await app.stub.release()
    await app.built.close()
    await app.warehouse.remove()
    await rm(app.directory, { recursive: true, force: true })
    app = undefined
  }
  vi.unstubAllEnvs()
})

describe('GET /labels: the plan part', () => {
  const SUBSCRIPTION_LINES = [
    'Log Book runs your own claude 2.1.290, signed in with a Claude subscription, on claude-haiku-4-5.',
    "Requests count against your Claude plan's usage limits.",
    'To label: 2,214 records (shell calls 2,140, sessions 12, outcomes 9, prompts 31, replies 22).',
    'By agent: Example Harness 1,630, Sample Harness 584.',
    'Excerpts of these records go to Anthropic through Claude Code; nothing is redacted.',
    'Estimated: about 560,000 input tokens. You can stop it at any time; what is labelled is kept.',
  ]

  it('shows what a run would send with a subscription, the model field and Start', async () => {
    // Arrange
    const { stub } = await startApp()

    // Act
    const page = await labelsPage()

    // Assert
    expect({ page, calls: await stub.calls() }).toStrictEqual({
      page: {
        status: 200,
        part: 'plan',
        lastRun: null,
        lines: SUBSCRIPTION_LINES,
        progress: null,
        model: 'claude-haiku-4-5',
        start: 'Start labelling with claude-haiku-4-5. You can stop it at any time; what is labelled is kept.',
        stop: null,
        isReloading: false,
      },
      calls: [['labels', 'plan']],
    })
  })

  it.each([
    [
      'an API key',
      { authMethod: 'console' },
      [
        'Log Book runs your own claude 2.1.290, signed in with an API key; labelling is billed to that account, on claude-haiku-4-5.',
        ...SUBSCRIPTION_LINES.slice(2),
      ],
    ],
    [
      'another provider',
      { authMethod: 'console', apiProvider: 'bedrock' },
      [
        'Log Book runs your own claude 2.1.290, signed in with an API key; labelling is billed to that account, on claude-haiku-4-5.',
        ...SUBSCRIPTION_LINES.slice(2, 4),
        'Excerpts of these records go to bedrock through Claude Code; nothing is redacted.',
        SUBSCRIPTION_LINES[5],
      ],
    ],
    [
      'ANTHROPIC_API_KEY set',
      { apiKeyInEnvironment: true },
      [
        SUBSCRIPTION_LINES[0],
        'ANTHROPIC_API_KEY is set, so Claude Code may bill this run to that key instead of your plan.',
        ...SUBSCRIPTION_LINES.slice(1),
      ],
    ],
    [
      'one record of a task',
      {
        tasks: PLAN.tasks.map((task) => ({ ...task, records: task.task === 'shell' ? 1 : 0 })),
        harnesses: [{ id: 'example', name: 'Example Harness', records: 1 }],
        records: 1,
        estimatedInputTokens: 250,
      },
      [
        ...SUBSCRIPTION_LINES.slice(0, 2),
        'To label: 1 record (shell call 1).',
        'By agent: Example Harness 1.',
        SUBSCRIPTION_LINES[4],
        'Estimated: about 250 input tokens. You can stop it at any time; what is labelled is kept.',
      ],
    ],
  ])('words the plan for %s', async (_case, change, lines) => {
    // Arrange
    const { stub } = await startApp()
    stub.answer(0, [], { stdout: JSON.stringify({ ...PLAN, ...change }) })

    // Act
    const page = await labelsPage()

    // Assert
    expect(page.lines).toStrictEqual(lines)
  })

  it('says there is nothing to label, with no estimate and no Start', async () => {
    // Arrange
    const { stub } = await startApp()
    const nothing = { ...PLAN, tasks: PLAN.tasks.map((task) => ({ ...task, records: 0 })), harnesses: [], records: 0 }
    stub.answer(0, [], { stdout: JSON.stringify(nothing) })

    // Act
    const page = await labelsPage()

    // Assert
    expect(page).toMatchObject({
      lines: [
        ...SUBSCRIPTION_LINES.slice(0, 2),
        'To label: nothing. Every record already has a label from a model.',
        SUBSCRIPTION_LINES[4],
      ],
      model: null,
      start: null,
    })
  })

  it.each([
    [7, NEEDS_CLAUDE, NEEDS_CLAUDE],
    [1, 'claude exited 2', 'Could not work out what to label: claude exited 2'],
  ])('shows a plan that exited %i by its last stderr line, with no Start', async (code, stderr, line) => {
    // Arrange
    const { stub } = await startApp()
    stub.answer(code, ['Detecting Claude Code', stderr])

    // Act
    const page = await labelsPage()

    // Assert
    expect(page).toMatchObject({ part: 'plan', lines: [line], model: null, start: null, stop: null })
  })

  it('plans with the model the URL names', async () => {
    // Arrange
    const { stub } = await startApp()

    // Act
    await labelsPage('/labels?model=claude-sonnet-5-5')

    // Assert
    expect(await stub.calls()).toStrictEqual([['labels', 'plan', '--model', 'claude-sonnet-5-5']])
  })

  it('runs one plan for two requests at once', async () => {
    // Arrange
    const { stub, built } = await startApp()
    stub.answer(0, [], { stdout: JSON.stringify(PLAN), isHolding: true })

    // Act
    const pages = Promise.all([labelsPage(), labelsPage()])
    await stub.pid()
    await vi.waitFor(async () => {
      expect(await built.connections()).toBe(2)
    })
    await stub.release()
    const [first, second] = await pages

    // Assert
    expect({ parts: [first.part, second.part], calls: await stub.calls() }).toStrictEqual({
      parts: ['plan', 'plan'],
      calls: [['labels', 'plan']],
    })
  })
})

describe('POST /labels and /labels/stop: a run started here', () => {
  it('starts the run, shows it starting, then running with its progress, then stopping, then the plan', async () => {
    // Arrange
    const { stub } = await startApp()
    stub.answer(0, [], { isWaiting: true, isLocking: true, isHoldingStop: true })

    // Act
    const start = await post('/labels', 'model=claude-haiku-4-5')
    const pid = await stub.pid()
    const starting = await labelsPage()
    const topBar = await topBarLabel()
    runRecord(pid)
    const running = await labelsPage()
    const stop = await post('/labels/stop', 'back=%2Flabels')
    await vi.waitFor(() => {
      expect(stub.isSignalled()).toBe(true)
    })
    const stopping = await labelsPage()
    await stub.release()
    await exited(pid)
    stub.answer(0, [], { stdout: JSON.stringify(PLAN) })
    const after = await labelsPage()

    // Assert
    expect({
      start: [start.status, start.headers.location],
      starting,
      topBar,
      running,
      stop: [stop.status, stop.headers.location],
      stopping,
      after: after.part,
      calls: await stub.calls(),
    }).toStrictEqual({
      start: [303, '/labels'],
      starting: {
        status: 200,
        part: 'starting',
        lastRun: null,
        lines: ['Starting: checking Claude Code and counting what to label…'],
        progress: null,
        model: null,
        start: null,
        stop: { isDisabled: false },
        isReloading: true,
      },
      topBar: 'Starting labelling…',
      running: {
        status: 200,
        part: 'running-here',
        lastRun: null,
        lines: [],
        progress: ['Labelling with claude-haiku-4-5, started 4 min ago: 1,240 of 2,214 records (56%).', ...PROGRESS],
        model: null,
        start: null,
        stop: { isDisabled: false },
        isReloading: true,
      },
      stop: [303, '/labels'],
      stopping: {
        status: 200,
        part: 'stopping',
        lastRun: null,
        lines: ['Stopping: no new batch starts; finished batches are kept.'],
        progress: ['Labelling with claude-haiku-4-5, started 4 min ago: 1,240 of 2,214 records (56%).', ...PROGRESS],
        model: null,
        start: null,
        stop: { isDisabled: true },
        isReloading: true,
      },
      after: 'plan',
      calls: [
        ['labels', 'update', '--model', 'claude-haiku-4-5'],
        ['labels', 'plan'],
      ],
    })
  })

  it.each([
    [9, 'updated', null, [UPDATED]],
    [7, 'plan', null, [NEEDS_CLAUDE]],
    [1, 'plan', 'Labelling failed 1 min ago', null],
    [3, 'plan', 'Labelled 12 min ago', null],
    [130, 'plan', null, null],
  ] as const)('shows a run child that exited %i without a record', async (code, part, lastRun, lines) => {
    // Arrange
    const { stub } = await startApp()
    if (code === 3) {
      runRecord(999_999, { endedAgo: 12 * MINUTE, outcome: 'ok' })
    }
    stub.answer(code, ['Detecting Claude Code', code === 7 ? NEEDS_CLAUDE : 'claude exited 2'])

    // Act
    await post('/labels', '')
    await vi.waitFor(async () => {
      expect(await topBarLabel()).not.toBe('Starting labelling…')
    })
    if (code !== 7) {
      stub.answer(0, [], { stdout: JSON.stringify(PLAN) })
    }
    const page = await labelsPage()

    // Assert
    expect({ part: page.part, lastRun: page.lastRun, isReloading: page.isReloading }).toStrictEqual({
      part,
      lastRun,
      isReloading: false,
    })
    expect(page.lines).toStrictEqual(lines ?? expect.arrayContaining([expect.stringMatching(/^Log Book runs/u)]))
  })
})

describe('the model', () => {
  it('answers 400 to a model outside the rule, on POST and on GET, and starts nothing', async () => {
    // Arrange
    const { stub } = await startApp()

    // Act
    const posted = await post('/labels', 'model=--help')
    const got = await send('GET', '/labels?model=--help')

    // Assert
    expect({
      statuses: [posted.status, got.status],
      isNamed: posted.body.includes('must start with a letter or digit'),
      calls: await stub.calls(),
    }).toStrictEqual({ statuses: [400, 400], isNamed: true, calls: [] })
  })
})

describe('a lock this app did not take', () => {
  it('shows a run elsewhere with its progress once a record carries its pid, and never starts or signals', async () => {
    // Arrange
    const { stub } = await startApp()
    const pid = lockElsewhere('labels')

    // Act
    const before = await labelsPage()
    runRecord(pid)
    const withRecord = await labelsPage()
    const start = await post('/labels', 'model=claude-haiku-4-5')
    const stop = await post('/labels/stop', 'back=%2Flabels')

    // Assert
    expect({
      before: [before.part, before.lines, before.progress, before.stop, before.isReloading],
      withRecord: [withRecord.lines, withRecord.progress, withRecord.stop],
      start: [start.status, start.headers.location],
      stop: [stop.status, stop.headers.location],
      isHolderAlive: isProcessAlive(pid),
      calls: await stub.calls(),
    }).toStrictEqual({
      before: [
        'running-elsewhere',
        ['Labelling in a terminal since 2 min. Stop it there with Ctrl+C.'],
        null,
        null,
        true,
      ],
      withRecord: [
        [],
        [
          'Labelling in a terminal, with claude-haiku-4-5, started 4 min ago: 1,240 of 2,214 records (56%). Stop it there with Ctrl+C.',
          ...PROGRESS,
        ],
        null,
      ],
      start: [303, '/labels'],
      stop: [303, '/labels'],
      isHolderAlive: true,
      calls: [],
    })
  })

  it.each([
    ['compact', 'Labelling waits: logbook compact is rewriting the warehouse (since 2 min).'],
    ['forget', 'Labelling waits: logbook forget is removing sessions (since 2 min).'],
  ] as const)('shows maintenance by %s, with no plan, no Start and no Stop', async (operation, line) => {
    // Arrange
    const { stub } = await startApp()
    lockElsewhere(operation)

    // Act
    const page = await labelsPage()
    const start = await post('/labels', 'model=claude-haiku-4-5')

    // Assert
    expect({ page, start: start.status, calls: await stub.calls() }).toStrictEqual({
      page: {
        status: 200,
        part: 'maintenance',
        lastRun: null,
        lines: [line],
        progress: null,
        model: null,
        start: null,
        stop: null,
        isReloading: true,
      },
      start: 303,
      calls: [],
    })
  })
})

describe('the routes', () => {
  it('answer 405 to other methods: the guard refuses PUT, and the stop route refuses GET naming POST', async () => {
    // Arrange
    await startApp()

    // Act
    const replies = await Promise.all([
      send('PUT', '/labels', { ...FORM, Origin: started().built.origin }),
      send('GET', '/labels/stop'),
    ])

    // Assert
    expect(replies.map((reply) => [reply.status, reply.headers.allow ?? null])).toStrictEqual([
      [405, null],
      [405, 'POST'],
    ])
  })

  it('answers 400 to a stop whose form names no page of this app', async () => {
    // Arrange
    await startApp()

    // Act
    const reply = await post('/labels/stop', 'back=https%3A%2F%2Fevil.example%2F')

    // Assert
    expect(reply.status).toBe(400)
  })
})
