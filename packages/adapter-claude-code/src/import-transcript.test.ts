import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ADAPTER_ERROR_CODES, IMAGE_PART_TEXT, validateImportedUnit, type IImportedUnit } from '@log-book/adapter-api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeCode } from './adapter.js'
import { importTranscript } from './import-transcript.js'

const isRoot = process.getuid?.() === 0
const SESSION = 'claude-code:session-1'
const LOCATOR = '-home-example-work-shop/session-1.jsonl'

// The time `seconds` after a fixed moment, as Claude Code writes it, and in epoch milliseconds.
const stamp = (seconds: number): string => new Date(Date.UTC(2026, 0, 2, 10, 0, seconds)).toISOString()
const at = (seconds: number): number => Date.UTC(2026, 0, 2, 10, 0, seconds)

type TLine = Record<string, unknown>

const user = (uuid: string, seconds: number, content: unknown, fields: TLine = {}): TLine => ({
  type: 'user',
  uuid,
  timestamp: stamp(seconds),
  message: { role: 'user', content },
  ...fields,
})

// `message` in the fields adds to the line's message instead of replacing it.
const assistant = (
  id: string,
  uuid: string,
  seconds: number,
  content: unknown[],
  { message, ...fields }: { message?: TLine; [field: string]: unknown } = {}
): TLine => ({
  type: 'assistant',
  uuid,
  timestamp: stamp(seconds),
  message: { id, role: 'assistant', model: 'claude-sonnet-5-5', content, ...message },
  ...fields,
})

const text = (value: string): TLine => ({ type: 'text', text: value })

const onlySession = (unit: IImportedUnit): IImportedUnit['sessions'][number] => {
  const [session] = unit.sessions
  if (session === undefined || unit.sessions.length !== 1) {
    throw new Error('Expected exactly one session')
  }
  return session
}

describe('importTranscript', () => {
  let directory = ''

  const importLines = async (lines: readonly (TLine | string)[], ending = '\n'): Promise<IImportedUnit> => {
    const path = join(directory, 'session-1.jsonl')
    await writeFile(
      path,
      lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + ending
    )
    return importTranscript(path, LOCATOR)
  }

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-claude-import-')))
  })

  afterEach(async () => {
    await chmod(directory, 0o700)
    await rm(directory, { recursive: true, force: true })
  })

  it('merges the lines of one response interleaved with its tool results into one message', async () => {
    // Arrange
    const lines = [
      user('u1', 0, 'run the tests'),
      assistant('msg_a', 'a1', 1, [{ type: 'thinking', thinking: 'Run them first.' }]),
      user('u2', 2, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]),
      assistant('msg_a', 'a2', 3, [text('All tests pass.')], {
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            output_tokens_details: { thinking_tokens: 3 },
            cache_read_input_tokens: 7,
          },
        },
      }),
    ]

    // Act
    const unit = await importLines(lines)

    // Assert
    const session = onlySession(unit)
    expect({
      messages: session.messages.map((message) => [
        message.id,
        message.actor,
        message.seq,
        message.createdAt,
        message.completedAt,
      ]),
      reply: session.messages.find((message) => message.actor === 'assistant'),
      parts: session.parts.map((part) => [part.messageId, part.idx, part.kind, part.text]),
      problems: validateImportedUnit(claudeCode().descriptor, unit),
    }).toStrictEqual({
      messages: [
        [`${SESSION}/u1`, 'user', 0, at(0), null],
        [`${SESSION}/msg_a`, 'assistant', 1, at(1), at(3)],
        [`${SESSION}/u2`, 'tool', 2, at(2), null],
      ],
      reply: {
        id: `${SESSION}/msg_a`,
        sessionId: SESSION,
        seq: 1,
        actor: 'assistant',
        sourceRole: 'assistant',
        createdAt: at(1),
        completedAt: at(3),
        requestedAt: at(0),
        model: 'claude-sonnet-5-5',
        agent: null,
        gitBranch: null,
        tokensInput: 10,
        tokensOutput: 5,
        tokensReasoning: 3,
        tokensCacheRead: 7,
        tokensCacheWrite: null,
        reportedCost: null,
      },
      parts: [
        [`${SESSION}/u1`, 0, 'text', 'run the tests'],
        [`${SESSION}/msg_a`, 0, 'reasoning', 'Run them first.'],
        [`${SESSION}/msg_a`, 1, 'text', 'All tests pass.'],
      ],
      problems: [],
    })
  })

  it('takes requestedAt from the previous message of any actor, and null on the first message', async () => {
    // Arrange
    const lines = [
      assistant('msg_0', 'a0', 0, [text('Hello.')]),
      user('u1', 1, 'go on', { isMeta: true }),
      assistant('msg_1', 'a1', 2, [text('Going on.')]),
    ]

    // Act
    const session = onlySession(await importLines(lines))

    // Assert
    expect(session.messages.map((message) => [message.actor, message.requestedAt])).toStrictEqual([
      ['assistant', null],
      ['harness', null],
      ['assistant', at(1)],
    ])
  })

  it.each<[string, unknown, TLine, string]>([
    ['<command-name>', '  <command-name>/review</command-name>', {}, 'harness'],
    ['<command-message>', '<command-message>review</command-message>', {}, 'harness'],
    ['<local-command-', '<local-command-stdout>done</local-command-stdout>', {}, 'harness'],
    ['[Request interrupted', [text('[Request interrupted by user]')], {}, 'harness'],
    ['isMeta', 'Caveat: the messages below were generated by the user.', { isMeta: true }, 'harness'],
    ['isCompactSummary', 'Summary of the earlier conversation.', { isCompactSummary: true }, 'harness'],
    ['a non-human origin', 'A background task finished.', { origin: { kind: 'task-notification' } }, 'harness'],
    ['a plain prompt', 'add a discount code field', {}, 'user'],
  ])('gives the actor for %s', async (_case, content, fields, actor) => {
    // Act
    const session = onlySession(await importLines([user('u1', 0, content, fields)]))

    // Assert
    expect(session.messages.map((message) => message.actor)).toStrictEqual([actor])
  })

  it('makes the parts of a compact summary compaction parts', async () => {
    // Act
    const session = onlySession(await importLines([user('u1', 0, 'Summary so far.', { isCompactSummary: true })]))

    // Assert
    expect(session.parts.map((part) => [part.kind, part.text])).toStrictEqual([['compaction', 'Summary so far.']])
  })

  it('gives an image-only prompt the one part (image)', async () => {
    // Act
    const session = onlySession(
      await importLines([user('u1', 0, [{ type: 'image', source: { type: 'base64', data: 'aGVsbG8=' } }])])
    )

    // Assert
    expect(session.parts.map((part) => [part.kind, part.text])).toStrictEqual([['text', IMAGE_PART_TEXT]])
  })

  it('makes a synthetic reply and an API error reply harness messages, the error with its event', async () => {
    // Arrange
    const lines = [
      assistant('msg_s', 's1', 0, [text('No response requested.')], { message: { model: '<synthetic>' } }),
      assistant('msg_e', 'e1', 1, [text('API Error: Connection dropped.')], {
        isApiErrorMessage: true,
        message: { model: '<synthetic>' },
      }),
    ]

    // Act
    const unit = await importLines(lines)

    // Assert
    const session = onlySession(unit)
    expect({
      messages: session.messages.map((message) => [message.id, message.actor, message.sourceRole, message.model]),
      parts: session.parts.map((part) => part.text),
      events: session.events,
      problems: validateImportedUnit(claudeCode().descriptor, unit),
    }).toStrictEqual({
      messages: [
        [`${SESSION}/s1`, 'harness', 'assistant', null],
        [`${SESSION}/e1`, 'harness', 'assistant', null],
      ],
      parts: ['No response requested.', 'API Error: Connection dropped.'],
      events: [
        {
          id: `${SESSION}/e1`,
          sessionId: SESSION,
          kind: 'error',
          at: at(1),
          dataJson: JSON.stringify({ error: 'API Error: Connection dropped.' }),
        },
      ],
      problems: [],
    })
  })

  it('makes a system local_command line a harness message', async () => {
    // Arrange
    const line = {
      type: 'system',
      subtype: 'local_command',
      uuid: 'l1',
      timestamp: stamp(0),
      content: '<local-command-stdout>Context: 12k tokens</local-command-stdout>',
    }

    // Act
    const session = onlySession(await importLines([line]))

    // Assert
    expect({
      messages: session.messages.map((message) => [message.actor, message.sourceRole]),
      parts: session.parts.map((part) => part.text),
    }).toStrictEqual({
      messages: [['harness', 'system/local_command']],
      parts: ['<local-command-stdout>Context: 12k tokens</local-command-stdout>'],
    })
  })

  it('takes the last custom title over the last AI title', async () => {
    // Arrange
    const lines = [
      { type: 'ai-title', aiTitle: 'First AI title' },
      { type: 'custom-title', customTitle: 'First custom title' },
      { type: 'ai-title', aiTitle: 'Last AI title' },
      { type: 'custom-title', customTitle: 'Last custom title' },
    ]

    // Act
    const titles = [
      onlySession(await importLines(lines)).session.title,
      onlySession(await importLines(lines.filter((line) => line.type === 'ai-title'))).session.title,
      onlySession(await importLines([])).session.title,
    ]

    // Assert
    expect(titles).toStrictEqual(['Last custom title', 'Last AI title', null])
  })

  it('fills the session fields, with sdk-cli making the session scripted', async () => {
    // Arrange
    const lines = [
      { type: 'custom-title', customTitle: 'Discount codes' },
      user('u1', 0, 'add a discount code field', {
        cwd: '/home/example/work/shop',
        entrypoint: 'sdk-cli',
        gitBranch: 'main',
      }),
      assistant('msg_1', 'a1', 4, [text('Added.')], { cwd: '/home/example/work/other', gitBranch: '' }),
    ]

    // Act
    const session = onlySession(await importLines(lines))

    // Assert
    expect({ session: session.session, branches: session.messages.map((message) => message.gitBranch) }).toStrictEqual({
      session: {
        id: SESSION,
        harness: 'claude-code',
        sourceId: 'session-1',
        origin: 'interactive',
        isScripted: true,
        projectDir: '/home/example/work/shop',
        title: 'Discount codes',
        agent: null,
        spawnedBySessionId: null,
        spawnedByToolCallId: null,
        startedAt: at(0),
        endedAt: at(4),
      },
      branches: ['main', null],
    })
  })

  it('keeps an interactive session unscripted', async () => {
    // Act
    const session = onlySession(await importLines([user('u1', 0, 'hello', { entrypoint: 'cli' })]))

    // Assert
    expect(session.session.isScripted).toBe(false)
  })

  it('skips a cut last line and gives no message for a line without a timestamp', async () => {
    // Arrange
    const lines = [
      user('u1', 0, 'first'),
      { ...user('u2', 1, 'no time'), timestamp: undefined },
      '{"type":"user","uuid":"u3"',
    ]

    // Act
    const session = onlySession(await importLines(lines, ''))

    // Assert
    expect(session.messages.map((message) => message.id)).toStrictEqual([`${SESSION}/u1`])
  })

  it('reports the newest version any line records as the harness version', async () => {
    // Arrange
    const lines = [
      user('u1', 0, 'one', { version: '2.1.9' }),
      user('u2', 1, 'two', { version: '2.1.286' }),
      user('u3', 2, 'three', { version: '2.1.30' }),
    ]

    // Act
    const unit = await importLines(lines)

    // Assert
    expect(unit.harnessVersion).toBe('2.1.286')
  })

  it('gives one session with no messages and null times for an empty transcript', async () => {
    // Act
    const unit = await importLines([], '')

    // Assert
    expect({ unit, problems: validateImportedUnit(claudeCode().descriptor, unit) }).toStrictEqual({
      unit: {
        harnessVersion: null,
        sessions: [
          {
            session: {
              id: SESSION,
              harness: 'claude-code',
              sourceId: 'session-1',
              origin: 'interactive',
              isScripted: false,
              projectDir: null,
              title: null,
              agent: null,
              spawnedBySessionId: null,
              spawnedByToolCallId: null,
              startedAt: null,
              endedAt: null,
            },
            messages: [],
            parts: [],
            toolCalls: [],
            events: [],
          },
        ],
      },
      problems: [],
    })
  })

  it('raises ADAPTER_UNIT_GONE for a removed main file', async () => {
    // Act
    const imported = importTranscript(join(directory, 'gone.jsonl'), LOCATOR)

    // Assert
    await expect(imported).rejects.toMatchObject({ code: ADAPTER_ERROR_CODES.ADAPTER_UNIT_GONE })
  })

  it.skipIf(isRoot)('raises ADAPTER_UNIT_UNREADABLE naming the locator for a file it cannot read', async () => {
    // Arrange
    const path = join(directory, 'locked.jsonl')
    await writeFile(path, `${JSON.stringify(user('u1', 0, 'hello'))}\n`)
    await chmod(path, 0o000)

    // Act
    const imported = importTranscript(path, LOCATOR)

    // Assert
    await expect(imported).rejects.toMatchObject({
      code: ADAPTER_ERROR_CODES.ADAPTER_UNIT_UNREADABLE,
      message: expect.stringContaining(LOCATOR) as unknown,
    })
  })
})
