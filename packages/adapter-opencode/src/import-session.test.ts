import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ADAPTER_ERROR_CODES, IMAGE_PART_TEXT, validateImportedUnit, type IImportedUnit } from '@log-book/adapter-api'
import { openSqlite } from '@log-book/core'
import type { IImportedSession } from '@log-book/warehouse'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openCode } from './adapter.js'
import { openDatabase } from './database.js'

const SESSION = 'opencode:ses_example01'
const SCHEMA = `
CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, agent TEXT, version TEXT,
  time_created INTEGER, time_updated INTEGER);
CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER,
  time_updated INTEGER, data TEXT);
`

interface IRow {
  id: string
  type: string
  seq: number
  data: unknown
}

const sessionRow = (id: string, parent: string | null = null): string =>
  `INSERT INTO session_v2 VALUES ('${id}', ${parent === null ? 'NULL' : `'${parent}'`}, '/home/example/work/shop', 'Coupons', 'build', '2.0.21', 500, 9000);`

const messageRow = (sessionId: string, { id, type, seq, data }: IRow): string =>
  `INSERT INTO session_message VALUES ('${id}', '${sessionId}', '${type}', ${String(seq)}, ${String(seq * 1000)}, ${String(seq * 1000)}, '${(typeof data === 'string' ? data : JSON.stringify(data)).replaceAll("'", "''")}');`

const onlySession = (unit: IImportedUnit): IImportedSession => {
  const [session] = unit.sessions
  if (session === undefined) {
    throw new Error('Expected one session')
  }
  return session
}

// A skill call with the given input and status.
const skillCall = (id: string, input: Record<string, unknown>, status: string): Record<string, unknown> => ({
  type: 'tool',
  id,
  name: 'skill',
  state: { status, input, content: [{ type: 'text', text: 'Write release notes.' }], error: 'not found' },
  time: { created: 1000, completed: 1500 },
})

// A bash call that failed with the given error.
const refusedCall = (id: string, type: string, message: string): Record<string, unknown> => ({
  type: 'tool',
  id,
  name: 'bash',
  state: { status: 'error', input: { command: 'git push' }, error: { type, message } },
  time: { created: 1100, completed: 1500 },
})

const eventsOf = (session: IImportedSession): unknown[][] =>
  session.events.map((event) => [event.id, event.kind, event.at, JSON.parse(event.dataJson) as unknown])

const context = {
  signal: new AbortController().signal,
  onProgress: () => undefined,
  openSqlite,
}

describe('importUnit for OpenCode', () => {
  let directory = ''
  let path = ''

  const importSession = async (sql: string, locator = 'ses_example01'): Promise<IImportedUnit> => {
    const db = await openSqlite(path, { isReadOnly: false })
    db.exec(`${SCHEMA}${sql}`)
    db.close()
    const reader = await openDatabase({ root: path, kind: 'file', describe: 'opencode.db' }, context)
    try {
      return await reader.importUnit({ locator, fingerprint: 'f' })
    } finally {
      await reader.close()
    }
  }

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-opencode-import-')))
    path = join(directory, 'opencode.db')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('maps every message row type, an unknown type and unparseable data', async () => {
    // Arrange
    const rows: IRow[] = [
      { id: 'msg_01', type: 'user', seq: 1, data: { text: 'add a discount code field', time: { created: 1000 } } },
      { id: 'msg_02', type: 'system', seq: 2, data: { text: 'Instructions loaded.' } },
      { id: 'msg_03', type: 'synthetic', seq: 3, data: { text: 'Continue.' } },
      {
        id: 'msg_04',
        type: 'assistant',
        seq: 4,
        data: {
          time: { created: 4000, completed: 4500 },
          agent: 'build',
          model: { id: 'claude-sonnet-5-5', providerID: 'anthropic' },
          tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 300, write: 7 } },
          cost: 0.02,
          content: [
            { type: 'reasoning', text: 'Reading the form.' },
            { type: 'text', text: 'Added the field.' },
            { type: 'text', text: '' },
          ],
        },
      },
      {
        id: 'msg_05',
        type: 'compaction',
        seq: 5,
        data: { summary: 'The field was added.', reason: 'overflow', status: 'done' },
      },
      { id: 'msg_06', type: 'agent-switched', seq: 6, data: { agent: 'plan' } },
      {
        id: 'msg_07',
        type: 'model-switched',
        seq: 7,
        data: { model: 'openai/gpt-5.5', previous: 'anthropic/claude-sonnet-5-5' },
      },
      { id: 'msg_08', type: 'idle', seq: 8, data: { outcome: 'done' } },
      { id: 'msg_09', type: 'brand-new', seq: 9, data: { detail: 1 } },
      { id: 'msg_10', type: 'user', seq: 10, data: '{"text": "cut' },
    ]

    // Act
    const unit = await importSession(
      `${sessionRow('ses_example01')}${rows.map((row) => messageRow('ses_example01', row)).join('')}`
    )

    // Assert
    const session = onlySession(unit)
    expect({
      messages: session.messages.map((message) => [
        message.id.slice(SESSION.length + 1),
        message.seq,
        message.actor,
        message.sourceRole,
        message.createdAt,
      ]),
      reply: session.messages.find((message) => message.actor === 'assistant'),
      parts: session.parts.map((part) => [part.messageId.slice(SESSION.length + 1), part.kind, part.text]),
      events: session.events.map((event) => [
        event.id.slice(SESSION.length + 1),
        event.kind,
        event.at,
        JSON.parse(event.dataJson) as unknown,
      ]),
      problems: validateImportedUnit(openCode().descriptor, unit),
      version: unit.harnessVersion,
    }).toStrictEqual({
      messages: [
        ['msg_01', 1, 'user', 'user', 1000],
        ['msg_02', 2, 'harness', 'system', 2000],
        ['msg_03', 3, 'harness', 'synthetic', 3000],
        ['msg_04', 4, 'assistant', 'assistant', 4000],
        ['msg_05', 5, 'harness', 'compaction', 5000],
      ],
      reply: {
        id: `${SESSION}/msg_04`,
        sessionId: SESSION,
        seq: 4,
        actor: 'assistant',
        sourceRole: 'assistant',
        createdAt: 4000,
        completedAt: 4500,
        requestedAt: 4000,
        model: 'anthropic/claude-sonnet-5-5',
        agent: 'build',
        gitBranch: null,
        tokensInput: 10,
        tokensOutput: 20,
        tokensReasoning: 5,
        tokensCacheRead: 300,
        tokensCacheWrite: 7,
        reportedCost: 0.02,
      },
      parts: [
        ['msg_01', 'text', 'add a discount code field'],
        ['msg_02', 'text', 'Instructions loaded.'],
        ['msg_03', 'text', 'Continue.'],
        ['msg_04', 'reasoning', 'Reading the form.'],
        ['msg_04', 'text', 'Added the field.'],
        ['msg_05', 'compaction', 'The field was added.'],
      ],
      events: [
        ['msg_05', 'compaction', 5000, { reason: 'overflow', status: 'done' }],
        ['msg_06', 'agent-switched', 6000, { agent: 'plan' }],
        ['msg_07', 'model-switched', 7000, { model: 'openai/gpt-5.5', previous: 'anthropic/claude-sonnet-5-5' }],
        ['msg_08', 'idle', 8000, { outcome: 'done' }],
        [
          'msg_09',
          'unknown',
          9000,
          {
            what: 'row',
            type: 'brand-new',
            harnessVersion: '2.0.21',
            raw: {
              id: 'msg_09',
              type: 'brand-new',
              seq: 9,
              time_created: 9000,
              time_updated: 9000,
              data: '{"detail":1}',
            },
          },
        ],
        ['msg_10', 'unknown', 10_000, { what: 'row', type: 'user', harnessVersion: '2.0.21', raw: '{"text": "cut' }],
      ],
      problems: [],
      version: '2.0.21',
    })
  })

  it('makes an image and a non-image file text parts, and an image-only prompt one (image) part', async () => {
    // Arrange
    const rows: IRow[] = [
      {
        id: 'msg_01',
        type: 'user',
        seq: 1,
        data: {
          text: 'see these',
          files: [
            { mime: 'image/png', name: 'box.png' },
            { mime: 'text/plain', name: 'notes.txt' },
          ],
        },
      },
      { id: 'msg_02', type: 'user', seq: 2, data: { text: '', files: [{ mime: 'image/jpeg', name: 'shot.jpg' }] } },
    ]

    // Act
    const session = onlySession(
      await importSession(
        `${sessionRow('ses_example01')}${rows.map((row) => messageRow('ses_example01', row)).join('')}`
      )
    )

    // Assert
    expect(session.parts.map((part) => [part.messageId.slice(SESSION.length + 1), part.text])).toStrictEqual([
      ['msg_01', 'see these'],
      ['msg_01', IMAGE_PART_TEXT],
      ['msg_01', '(file: notes.txt)'],
      ['msg_02', IMAGE_PART_TEXT],
    ])
  })

  it("takes a migrated message's completion from the 1.x message table", async () => {
    // Arrange
    const sql = `${sessionRow('ses_example01')}
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      INSERT INTO message VALUES ('msg_01', 'ses_example01', '{"time":{"created":1000,"completed":1500}}');
      ${messageRow('ses_example01', { id: 'msg_01', type: 'assistant', seq: 1, data: { time: { created: 1000, completed: 900_000 }, content: [{ type: 'text', text: 'Done.' }] } })}`

    // Act
    const session = onlySession(await importSession(sql))

    // Assert
    expect(session.messages.map((message) => message.completedAt)).toStrictEqual([1500])
  })

  it.each([
    ['a type and a message', { type: 'APIError', message: 'Overloaded' }, 'APIError: Overloaded'],
    ['only a message', { message: 'Connection dropped' }, 'Connection dropped'],
    ['a string', 'Aborted', 'Aborted'],
    ['anything else', { code: 529 }, '{"code":529}'],
  ])('writes the error text for an error with %s', async (_case, error, text) => {
    // Arrange
    const row: IRow = {
      id: 'msg_01',
      type: 'assistant',
      seq: 1,
      data: { content: [{ type: 'text', text: 'Partly done.' }], error },
    }

    // Act
    const session = onlySession(
      await importSession(`${sessionRow('ses_example01')}${messageRow('ses_example01', row)}`)
    )

    // Assert
    expect({
      events: session.events.map((event) => [event.kind, event.dataJson]),
      parts: session.parts.map((part) => part.text),
    }).toStrictEqual({ events: [['error', JSON.stringify({ error: text })]], parts: ['Partly done.'] })
  })

  it.each([
    ['a root session whose first prompt is a whole quoted string with a space', null, ['"fix the build"'], true],
    ['a quoted string without a space', null, ['"fix"'], false],
    ['a quoted prompt that is not the first', null, ['fix the build', '"and then the tests"'], false],
    ['a child session with a quoted first prompt', 'ses_parent', ['"fix the build"'], false],
  ])('gives isScripted for %s', async (_case, parent, prompts, isScripted) => {
    // Arrange
    const rows = prompts.map((text, index) =>
      messageRow('ses_example01', { id: `msg_0${String(index + 1)}`, type: 'user', seq: index + 1, data: { text } })
    )

    // Act
    const session = onlySession(await importSession(`${sessionRow('ses_example01', parent)}${rows.join('')}`))

    // Assert
    expect({
      isScripted: session.session.isScripted,
      spawnedBy: session.session.spawnedBySessionId,
    }).toStrictEqual({ isScripted, spawnedBy: parent === null ? null : `opencode:${parent}` })
  })

  it('falls back to time_created for the start of a session with no messages', async () => {
    // Act
    const session = onlySession(await importSession(sessionRow('ses_example01')))

    // Assert
    expect([session.session.startedAt, session.session.endedAt]).toStrictEqual([500, null])
  })

  it('raises ADAPTER_UNIT_GONE for a deleted session', async () => {
    // Act
    const imported = importSession(sessionRow('ses_example01'), 'ses_deleted')

    // Assert
    await expect(imported).rejects.toMatchObject({ code: ADAPTER_ERROR_CODES.ADAPTER_UNIT_GONE })
  })

  it.each<[string, Record<string, unknown>, string, string | null]>([
    [
      'an error',
      { status: 'error', error: { type: 'ToolError', message: 'File not found' } },
      'error',
      'ToolError: File not found',
    ],
    [
      'a completed shell call that exited non-zero',
      { status: 'completed', metadata: { exit: 2 }, content: [{ type: 'text', text: 'failed' }] },
      'error',
      'failed',
    ],
    [
      'a completed call',
      {
        status: 'completed',
        metadata: { exit: 0 },
        content: [{ type: 'text', text: 'line one' }, { type: 'image' }, { type: 'text', text: 'line two' }],
      },
      'completed',
      'line one\nline two',
    ],
    ['a running call', { status: 'running' }, 'pending', null],
  ])('records the status and result of %s', async (_case, state, status, result) => {
    // Arrange
    const row: IRow = {
      id: 'msg_01',
      type: 'assistant',
      seq: 1,
      data: {
        content: [
          {
            type: 'tool',
            id: 'prt_01',
            name: 'bash',
            state: { input: { command: 'pnpm test' }, ...state },
            time: { created: 1000, ran: 1200, completed: 1900 },
          },
        ],
      },
    }

    // Act
    const session = onlySession(
      await importSession(`${sessionRow('ses_example01')}${messageRow('ses_example01', row)}`)
    )

    // Assert
    expect({
      call: session.toolCalls.map((call) => [
        call.id,
        call.name,
        call.bareName,
        call.server,
        call.family,
        call.inputJson,
        call.status,
        call.startedAt,
        call.endedAt,
      ]),
      parts: session.parts.map((part) => [part.kind, part.text, part.toolCallId]),
    }).toStrictEqual({
      call: [[`${SESSION}/prt_01`, 'bash', 'bash', null, 'shell', '{"command":"pnpm test"}', status, 1200, 1900]],
      parts: [
        ['tool_call', 'bash {"command":"pnpm test"}', `${SESSION}/prt_01`],
        ...(result === null ? [] : [['tool_result', result, `${SESSION}/prt_01`]]),
      ],
    })
  })

  it('times a call with no ran time from its creation, and links a 1.x task call to its child', async () => {
    // Arrange
    const row: IRow = {
      id: 'msg_01',
      type: 'assistant',
      seq: 1,
      data: {
        content: [
          {
            type: 'tool',
            id: 'prt_01',
            name: 'task',
            state: { status: 'completed', input: { prompt: 'look' }, metadata: { sessionId: 'ses_child01' } },
            time: { created: 1000 },
          },
        ],
      },
    }

    // Act
    const session = onlySession(
      await importSession(`${sessionRow('ses_example01')}${messageRow('ses_example01', row)}`)
    )

    // Assert
    expect(
      session.toolCalls.map((call) => [call.family, call.childSessionId, call.startedAt, call.endedAt])
    ).toStrictEqual([['subagent', 'opencode:ses_child01', 1000, null]])
  })

  it('records a skill-loaded event for a completed skill call, by name or id, and none for a failed one', async () => {
    // Arrange
    const row: IRow = {
      id: 'msg_01',
      type: 'assistant',
      seq: 1,
      data: {
        time: { created: 900 },
        content: [
          skillCall('prt_01', { name: 'write-release-notes' }, 'completed'),
          skillCall('prt_02', { id: 'review-checklist' }, 'completed'),
          skillCall('prt_03', { name: 'missing-skill' }, 'error'),
        ],
      },
    }

    // Act
    const session = onlySession(
      await importSession(`${sessionRow('ses_example01')}${messageRow('ses_example01', row)}`)
    )

    // Assert
    expect(
      session.events.map((event) => [event.id, event.kind, event.at, JSON.parse(event.dataJson) as unknown])
    ).toStrictEqual([
      [
        `${SESSION}/prt_01:skill`,
        'skill-loaded',
        1500,
        { name: 'write-release-notes', chars: 20, toolCallId: `${SESSION}/prt_01` },
      ],
      [
        `${SESSION}/prt_02:skill`,
        'skill-loaded',
        1500,
        { name: 'review-checklist', chars: 20, toolCallId: `${SESSION}/prt_02` },
      ],
    ])
  })

  it('records an unknown part type as an unknown event at the message time', async () => {
    // Arrange
    const row: IRow = {
      id: 'msg_01',
      type: 'assistant',
      seq: 1,
      data: {
        time: { created: 900 },
        content: [
          { type: 'text', text: 'Done.' },
          { type: 'step-marker', step: 2 },
        ],
      },
    }

    // Act
    const session = onlySession(
      await importSession(`${sessionRow('ses_example01')}${messageRow('ses_example01', row)}`)
    )

    // Assert
    expect(
      session.events.map((event) => [event.id, event.kind, event.at, JSON.parse(event.dataJson) as unknown])
    ).toStrictEqual([
      [
        `${SESSION}/msg_01:part-1`,
        'unknown',
        900,
        { what: 'part', type: 'step-marker', harnessVersion: '2.0.21', raw: { type: 'step-marker', step: 2 } },
      ],
    ])
  })

  it('records one interrupted event for an aborted 2.0 request, keeping its error and idle events', async () => {
    // Arrange
    const rows: IRow[] = [
      {
        id: 'msg_01',
        type: 'assistant',
        seq: 1,
        data: {
          time: { created: 1000, completed: 1800 },
          content: [{ type: 'text', text: 'Starting.' }],
          error: { type: 'aborted', message: 'Step interrupted' },
        },
      },
      { id: 'msg_02', type: 'idle', seq: 2, data: { outcome: 'interrupted', time: { created: 1900 } } },
    ]

    // Act
    const session = onlySession(
      await importSession(
        `${sessionRow('ses_example01')}${rows.map((row) => messageRow('ses_example01', row)).join('')}`
      )
    )

    // Assert
    expect(eventsOf(session)).toStrictEqual([
      [`${SESSION}/msg_01`, 'error', 1000, { error: 'aborted: Step interrupted' }],
      [`${SESSION}/msg_01:interrupted`, 'interrupted', 1800, { messageId: `${SESSION}/msg_01` }],
      [`${SESSION}/msg_02`, 'idle', 1900, { outcome: 'interrupted' }],
    ])
  })

  it('records interrupted for an aborted message migrated from 1.x', async () => {
    // Arrange
    const row: IRow = {
      id: 'msg_01',
      type: 'assistant',
      seq: 1,
      data: { time: { created: 1000 }, error: { type: 'aborted', message: 'The operation was aborted.' } },
    }

    // Act
    const session = onlySession(
      await importSession(
        `${sessionRow('ses_example01').replace("'2.0.21'", "'1.18.34'")}${messageRow('ses_example01', row)}`
      )
    )

    // Assert
    expect(eventsOf(session).map(([id, kind, at]) => [id, kind, at])).toStrictEqual([
      [`${SESSION}/msg_01`, 'error', 1000],
      [`${SESSION}/msg_01:interrupted`, 'interrupted', 1000],
    ])
  })

  it('records tool-rejected and interrupted for a declined call, and tool-rejected only for one rejected with a reason', async () => {
    // Arrange
    const rows: IRow[] = [
      {
        id: 'msg_01',
        type: 'assistant',
        seq: 1,
        data: {
          time: { created: 1000, completed: 1600 },
          content: [refusedCall('prt_01', 'aborted', 'The user declined this tool call')],
          error: { type: 'aborted', message: 'Step interrupted' },
        },
      },
      {
        id: 'msg_02',
        type: 'assistant',
        seq: 2,
        data: {
          time: { created: 2000 },
          content: [refusedCall('prt_02', 'permission.rejected', 'run the tests first')],
        },
      },
    ]

    // Act
    const session = onlySession(
      await importSession(
        `${sessionRow('ses_example01')}${rows.map((row) => messageRow('ses_example01', row)).join('')}`
      )
    )

    // Assert
    expect(eventsOf(session).map(([id, kind, at, data]) => [id, kind, at, data])).toStrictEqual([
      [`${SESSION}/prt_01:rejected`, 'tool-rejected', 1500, { toolCallId: `${SESSION}/prt_01` }],
      [`${SESSION}/msg_01`, 'error', 1000, { error: 'aborted: Step interrupted' }],
      [`${SESSION}/msg_01:interrupted`, 'interrupted', 1600, { messageId: `${SESSION}/msg_01` }],
      [`${SESSION}/prt_02:rejected`, 'tool-rejected', 1500, { toolCallId: `${SESSION}/prt_02` }],
    ])
  })

  it.each([
    ['a deny rule', 'permission.rejected', 'Permission denied: bash is not allowed here'],
    [
      'opencode run',
      'permission.rejected',
      'This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action.',
    ],
    ['a tool that was running when OpenCode ended', 'tool.interrupted', 'Tool interrupted'],
    ['an interrupted tool', 'aborted', 'Tool execution interrupted'],
  ])('records no refusal or interruption for %s', async (_case, type, message) => {
    // Arrange
    const row: IRow = {
      id: 'msg_01',
      type: 'assistant',
      seq: 1,
      data: { time: { created: 1000 }, content: [refusedCall('prt_01', type, message)] },
    }

    // Act
    const session = onlySession(
      await importSession(`${sessionRow('ses_example01')}${messageRow('ses_example01', row)}`)
    )

    // Assert
    expect({ events: session.events, status: session.toolCalls.map((call) => call.status) }).toStrictEqual({
      events: [],
      status: ['error'],
    })
  })

  it('records no refusal in a session recorded by 1.x', async () => {
    // Arrange
    const row: IRow = {
      id: 'msg_01',
      type: 'assistant',
      seq: 1,
      data: { time: { created: 1000 }, content: [refusedCall('prt_01', 'permission.rejected', 'not now')] },
    }

    // Act
    const session = onlySession(
      await importSession(
        `${sessionRow('ses_example01').replace("'2.0.21'", "'1.18.34'")}${messageRow('ses_example01', row)}`
      )
    )

    // Assert
    expect(session.events).toStrictEqual([])
  })
})
