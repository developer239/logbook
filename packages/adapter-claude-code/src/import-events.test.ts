import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateImportedUnit, type IImportedUnit } from '@log-book/adapter-api'
import type { IEventRecord } from '@log-book/warehouse'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeCode } from './adapter.js'
import { importTranscript } from './import-transcript.js'

const SESSION = 'claude-code:session-1'
const LOCATOR = '-home-example-work-shop/session-1.jsonl'

const stamp = (seconds: number): string => new Date(Date.UTC(2026, 0, 2, 10, 0, seconds)).toISOString()
const at = (seconds: number): number => Date.UTC(2026, 0, 2, 10, 0, seconds)

type TLine = Record<string, unknown>

const line = (uuid: string, seconds: number, fields: TLine): TLine => ({
  uuid,
  timestamp: stamp(seconds),
  version: '2.1.286',
  ...fields,
})

const event = (id: string, kind: IEventRecord['kind'], seconds: number, data: unknown): IEventRecord => ({
  id: `${SESSION}/${id}`,
  sessionId: SESSION,
  kind,
  at: at(seconds),
  dataJson: JSON.stringify(data),
})

describe('importTranscript events and unknown records', () => {
  let directory = ''

  const importLines = async (lines: readonly (TLine | string)[]): Promise<IImportedUnit> => {
    const path = join(directory, 'session-1.jsonl')
    await writeFile(
      path,
      `${lines.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n')}\n`
    )
    return importTranscript(path, LOCATOR)
  }

  const eventsOf = async (
    lines: readonly (TLine | string)[]
  ): Promise<{ events: IEventRecord[]; problems: string[] }> => {
    const unit = await importLines(lines)
    return {
      events: unit.sessions.flatMap((session) => session.events),
      problems: validateImportedUnit(claudeCode().descriptor, unit),
    }
  }

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-claude-events-')))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it.each<[string, TLine, IEventRecord]>([
    [
      'compact_boundary',
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 160_000 } },
      event('l1', 'compaction', 1, { metadata: { trigger: 'auto', preTokens: 160_000 } }),
    ],
    [
      'api_error',
      { type: 'system', subtype: 'api_error', error: { status: 529 }, retryAttempt: 2 },
      event('l1', 'error', 1, { error: { status: 529 }, retryAttempt: 2 }),
    ],
    [
      'deferred_tools_delta',
      {
        type: 'attachment',
        attachment: {
          type: 'deferred_tools_delta',
          addedNames: ['search_docs', 'create_issue'],
          readdedNames: ['create_issue', 'list_issues'],
          removedNames: ['old_tool'],
          retractedTools: [{ name: 'retired_tool' }],
          surfacedNames: ['search_docs'],
          pendingMcpServers: ['docs'],
          failedMcpServers: [{ name: 'tracker', error: 'connection refused' }],
        },
      },
      event('l1', 'tools-offered', 1, {
        added: ['search_docs', 'create_issue', 'list_issues'],
        removed: ['old_tool', 'retired_tool'],
        surfaced: ['search_docs'],
        pendingServers: ['docs'],
        needsAuthServers: null,
        failedServers: [{ name: 'tracker', error: 'connection refused' }],
      }),
    ],
    [
      'deferred_tools_record',
      {
        type: 'attachment',
        attachment: {
          type: 'deferred_tools_record',
          entries: [{ name: 'search_docs', description: 'Search the docs.', input_schema: { type: 'object' } }],
        },
      },
      event('l1', 'tools-loaded', 1, { tools: [{ name: 'search_docs', chars: 11 + 16 + 17 }] }),
    ],
  ])('maps %s to its event', async (_kind, fields, expected) => {
    // Act
    const found = await eventsOf([line('l1', 1, fields)])

    // Assert
    expect(found).toStrictEqual({ events: [expected], problems: [] })
  })

  it.each([
    ['with sourceToolUseID', { sourceToolUseID: 'toolu_1' }, `${SESSION}/toolu_1`],
    ['without sourceToolUseID', {}, null],
  ])('maps a skill load %s, keeping the line a harness message', async (_case, fields, toolCallId) => {
    // Arrange
    const text = 'Base directory for this skill: /home/example/.claude/skills/write-release-notes\n\nWrite the notes.'
    const lines = [
      line('u1', 1, {
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: [{ type: 'text', text }] },
        ...fields,
      }),
    ]

    // Act
    const unit = await importLines(lines)

    // Assert
    const [session] = unit.sessions
    expect({
      actors: session?.messages.map((message) => message.actor),
      events: session?.events,
    }).toStrictEqual({
      actors: ['harness'],
      events: [event('u1:skill', 'skill-loaded', 1, { name: 'write-release-notes', chars: text.length, toolCallId })],
    })
  })

  it('gives no event for a deferred_tools_record with no named entries, nor for an ignored kind', async () => {
    // Arrange
    const lines = [
      line('l1', 1, { type: 'attachment', attachment: { type: 'deferred_tools_record', entries: [] } }),
      line('l2', 2, { type: 'attachment', attachment: { type: 'date', date: '2026-01-02' } }),
      line('l3', 3, { type: 'system', subtype: 'turn_duration', durationMs: 1200 }),
      line('l4', 4, { type: 'file-history-snapshot', snapshot: {} }),
    ]

    // Act
    const found = await eventsOf(lines)

    // Assert
    expect(found).toStrictEqual({ events: [], problems: [] })
  })

  it('keeps an unknown type, system subtype, attachment type and block as one unknown event each', async () => {
    // Arrange
    const typeLine = line('l1', 1, { type: 'brand-new-kind', detail: 1 })
    const systemLine = line('l2', 2, { type: 'system', subtype: 'brand_new_notice' })
    const attachmentLine = line('l3', 3, { type: 'attachment', attachment: { type: 'brand_new_context' } })
    const block = { type: 'brand_new_block', data: 'x' }
    const assistantLine = line('l4', 4, {
      type: 'assistant',
      message: { id: 'msg_1', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Done.' }, block] },
    })

    // Act
    const found = await eventsOf([typeLine, systemLine, attachmentLine, assistantLine])

    // Assert
    expect(found).toStrictEqual({
      events: [
        event('l1', 'unknown', 1, { what: 'record', type: 'brand-new-kind', harnessVersion: '2.1.286', raw: typeLine }),
        event('l2', 'unknown', 2, {
          what: 'record',
          type: 'system:brand_new_notice',
          harnessVersion: '2.1.286',
          raw: systemLine,
        }),
        event('l3', 'unknown', 3, {
          what: 'record',
          type: 'attachment:brand_new_context',
          harnessVersion: '2.1.286',
          raw: attachmentLine,
        }),
        event('l4:block-1', 'unknown', 4, {
          what: 'block',
          type: 'brand_new_block',
          harnessVersion: '2.1.286',
          raw: block,
        }),
      ],
      problems: [],
    })
  })

  it('keeps an unparseable middle line as a string, at the time of the line before it', async () => {
    // Arrange
    const lines = [
      line('u1', 1, { type: 'user', message: { role: 'user', content: 'hello' } }),
      '{"type":"user","broken',
      line('u2', 5, { type: 'user', message: { role: 'user', content: 'again' } }),
    ]

    // Act
    const found = await eventsOf(lines)

    // Assert
    expect(found).toStrictEqual({
      events: [
        event('line-2', 'unknown', 1, {
          what: 'record',
          type: null,
          harnessVersion: null,
          raw: '{"type":"user","broken',
        }),
      ],
      problems: [],
    })
  })

  it("gives an unknown line before any timed line the session's first recorded time", async () => {
    // Arrange
    const untimed = { type: 'brand-new-kind', uuid: 'l1' }
    const lines = [untimed, line('u1', 7, { type: 'user', message: { role: 'user', content: 'hello' } })]

    // Act
    const found = await eventsOf(lines)

    // Assert
    expect(found).toStrictEqual({
      events: [
        event('l1', 'unknown', 7, { what: 'record', type: 'brand-new-kind', harnessVersion: null, raw: untimed }),
      ],
      problems: [],
    })
  })

  it('keeps a mapped line without a timestamp as an unknown record, and stores none for a session with no time', async () => {
    // Arrange
    const untimed = { type: 'user', uuid: 'u1', message: { role: 'user', content: 'no time' } }

    // Act
    const found = [
      await eventsOf([untimed]),
      await eventsOf([untimed, line('u2', 3, { type: 'user', message: { role: 'user', content: 'timed' } })]),
    ]

    // Assert
    expect(found.map(({ events }) => events)).toStrictEqual([
      [],
      [event('u1', 'unknown', 3, { what: 'record', type: 'user', harnessVersion: null, raw: untimed })],
    ])
  })

  it('gives a line without a uuid the source id line-<n>', async () => {
    // Arrange
    const lines = [
      line('u1', 1, { type: 'user', message: { role: 'user', content: 'hello' } }),
      { type: 'system', subtype: 'compact_boundary', timestamp: stamp(2), compactMetadata: null },
    ]

    // Act
    const found = await eventsOf(lines)

    // Assert
    expect(found).toStrictEqual({ events: [event('line-2', 'compaction', 2, { metadata: null })], problems: [] })
  })

  it('gives an unknown entrypoint one field event per session', async () => {
    // Arrange
    const lines = [
      line('u1', 1, { type: 'user', entrypoint: 'sdk-ts', message: { role: 'user', content: 'hello' } }),
      line('u2', 2, { type: 'user', entrypoint: 'sdk-ts', message: { role: 'user', content: 'again' } }),
    ]

    // Act
    const unit = await importLines(lines)

    // Assert
    expect({
      events: unit.sessions.flatMap((session) => session.events),
      isScripted: unit.sessions[0]?.session.isScripted,
    }).toStrictEqual({
      events: [event('field-entrypoint', 'unknown', 1, { what: 'field', field: 'entrypoint', value: 'sdk-ts' })],
      isScripted: false,
    })
  })

  describe('interruptions and refused tool calls', () => {
    const refusal = "The user doesn't want to proceed with this tool use. The tool use was rejected."

    const call = (seconds: number): TLine =>
      line('a1', seconds, {
        type: 'assistant',
        message: {
          id: 'msg_1',
          model: 'claude-sonnet-5-5',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'git push' } }],
        },
      })

    const result = (seconds: number, content: string): TLine =>
      line('r1', seconds, {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content, is_error: true }] },
      })

    const marker = (uuid: string, seconds: number, text: string): TLine =>
      line(uuid, seconds, { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })

    it.each([
      ['[Request interrupted by user]', '[Request interrupted by user]'],
      ['[Request interrupted by user for tool use]', '[Request interrupted by user for tool use]'],
      ['a marker with leading whitespace', '  \n[Request interrupted by user]'],
    ])('gives %s one interrupted event pointing at its message', async (_form, text) => {
      // Act
      const found = await eventsOf([marker('m1', 2, text)])

      // Assert
      expect(found).toStrictEqual({
        events: [event('m1:interrupted', 'interrupted', 2, { messageId: `${SESSION}/m1` })],
        problems: [],
      })
    })

    it("gives a refused call's result one tool-rejected event with the call's id and end time", async () => {
      // Act
      const unit = await importLines([call(1), result(4, refusal)])

      // Assert
      const [session] = unit.sessions
      expect({
        events: session?.events,
        call: session?.toolCalls.map((record) => [record.status, record.endedAt]),
        problems: validateImportedUnit(claudeCode().descriptor, unit),
      }).toStrictEqual({
        events: [event('toolu_1:rejected', 'tool-rejected', 4, { toolCallId: `${SESSION}/toolu_1` })],
        call: [['error', at(4)]],
        problems: [],
      })
    })

    it('gives a refusal followed by its marker both events', async () => {
      // Act
      const found = await eventsOf([
        call(1),
        result(4, refusal),
        marker('m1', 5, '[Request interrupted by user for tool use]'),
      ])

      // Assert
      expect(found).toStrictEqual({
        events: [
          event('toolu_1:rejected', 'tool-rejected', 4, { toolCallId: `${SESSION}/toolu_1` }),
          event('m1:interrupted', 'interrupted', 5, { messageId: `${SESSION}/m1` }),
        ],
        problems: [],
      })
    })

    it('gives a failed call with other error text no event', async () => {
      // Act
      const found = await eventsOf([call(1), result(4, 'Exit code 1: permission denied')])

      // Assert
      expect(found).toStrictEqual({ events: [], problems: [] })
    })
  })
})
