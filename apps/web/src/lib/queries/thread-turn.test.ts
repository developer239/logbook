import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seedRows, START } from '../testing/rows'
import { seedWarehouse, type ITestWarehouse } from '../testing/warehouse'
import { MINUTE } from '../time'
import type * as Plugins from './plugins-view'
import type * as Session from './session'
import type * as Thread from './thread'
import type * as Turn from './turn'

let warehouse: ITestWarehouse
let session: typeof Session
let thread: typeof Thread
let turn: typeof Turn
let plugins: typeof Plugins

beforeAll(async () => {
  warehouse = await seedWarehouse(seedRows)
  session = await import('./session')
  thread = await import('./thread')
  turn = await import('./turn')
  plugins = await import('./plugins-view')
})

afterAll(async () => {
  await warehouse.remove()
})

describe('sessionOf', () => {
  it('should read a session whole: its turns, messages and tools', () => {
    const read = session.sessionOf(session.sessionCache(), 'ses-me')

    expect(read).toMatchObject({
      id: 'ses-me',
      harness: 'claude-code',
      agent: null,
      model: 'model-a',
      outcome: 'failed',
    })
    expect(read.turns.map((row) => row.id)).toEqual(['m-me-1', 'm-me-4'])
    expect(read.turns.map((row) => row.messages.map((message) => message.id))).toEqual([
      ['m-me-1', 'm-me-2', 'm-me-3'],
      ['m-me-4', 'm-me-5'],
    ])
    expect(read.tools).toHaveLength(9)
    expect(
      read.toolsByMessage
        .get('m-me-3')
        ?.map((tool) => tool.id)
        .toSorted()
    ).toEqual(['c-edit-1', 'c-edit-2', 'c-edit-3', 'c-spawn'])
  })

  it('should read what a message cost the model to read and to write', () => {
    const read = session.sessionOf(session.sessionCache(), 'ses-me')

    expect(read.messageById.get('m-me-1')).toMatchObject({
      tokensRead: null,
      tokensWritten: null,
      text: 'Fix the widget please',
    })
    expect(read.messageById.get('m-me-2')).toMatchObject({ tokensRead: 5500, tokensWritten: 200 })
    expect(read.messageById.get('m-me-4')?.compactionSummary).toBe('Summary of the earlier work')
  })

  it('should read a call with its result, its labels and its time', () => {
    const read = session.sessionOf(session.sessionCache(), 'ses-me')

    expect(read.tools.find((tool) => tool.id === 'c-bash-fail')).toEqual({
      id: 'c-bash-fail',
      messageId: 'm-me-2',
      name: 'Bash',
      bareName: 'Bash',
      server: null,
      family: 'shell',
      status: 'error',
      inputJson: '{"command":"npm test"}',
      startedAt: START + MINUTE + 30_000,
      endedAt: START + MINUTE + 40_000,
      output: null,
      purpose: 'check a change (format, lint, typecheck, build)',
      label: 'command mistake',
    })
    expect(read.tools.find((tool) => tool.id === 'c-notes')?.output).toBe('saved')
  })

  it('should count calls by name, and the reactions in its prompts and the agents it started', () => {
    const read = session.sessionOf(session.sessionCache(), 'ses-me')
    const child = { sessionId: 'ses-agent', turnId: 'm-ag-1' }

    expect(read.callsByName.get('Edit')).toBe(3)
    expect(read.reactions).toEqual(new Map([['m-me-4', ['correction', 'teaching', 'praise']]]))
    expect(read.childrenOfTurn.get('m-me-1')).toEqual([{ ...child, under: 'm-me-1' }])
    expect(read.childrenOfCall.get('c-spawn')).toEqual([{ ...child, under: 'c-spawn' }])
  })

  it('should read the size of a tool definition the harness recorded', () => {
    const read = session.sessionOf(session.sessionCache(), 'ses-me')

    expect(read.definitionTokens).toEqual(new Map([['mcp__opencode__notes_add', 100]]))
  })

  it('should read a session once for a page', () => {
    const cache = session.sessionCache()

    expect(session.sessionOf(cache, 'ses-me')).toBe(session.sessionOf(cache, 'ses-me'))
  })

  it('should refuse a session the warehouse does not have', () => {
    expect(() => session.sessionOf(session.sessionCache(), 'ses-none')).toThrow('No session ses-none')
  })
})

describe('thread', () => {
  it('should lay a conversation out turn by turn', () => {
    const { agent, turns } = thread.thread(session.sessionCache(), 'ses-me')

    expect(agent).toBe('Claude')
    expect(turns.map((row) => [row.number, row.prompt, row.steps, row.failed])).toEqual([
      [1, { text: 'Fix the widget please', reactions: [] }, 9, 4],
      [2, { text: 'No, use the other widget', reactions: ['correction', 'teaching', 'praise'] }, 3, 1],
    ])
    expect(turns[0]?.reply).toEqual({ text: 'Done', model: 'model-a', at: START + 4 * MINUTE })
    expect(turns[1]?.compactions).toEqual([{ at: START + 10 * MINUTE, summary: 'Summary of the earlier work' }])
  })

  it('should show an agent a turn started with only the turns placed there', () => {
    const { turns } = thread.thread(session.sessionCache(), 'ses-me')

    expect(turns[0]?.spawned).toHaveLength(1)
    expect(turns[0]?.spawned[0]).toMatchObject({
      sessionId: 'ses-agent',
      underTurnId: 'm-me-1',
      agent: 'reviewer',
      harness: 'claude-code',
      outcome: 'done',
      steps: 1,
      failed: 0,
      durationMs: 4 * MINUTE,
    })
    expect(turns[0]?.spawned[0]?.turns.map((row) => [row.prompt?.text, row.harnessLines])).toEqual([
      ['Review the widget', ['Skill: writing']],
    ])
  })

  it('should show a slash command the human ran as their prompt', () => {
    const { turns } = thread.thread(session.sessionCache(), 'ses-script')

    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt).toEqual({ text: '`/ship`', reactions: [] })
    expect(turns[0]?.harnessLines).toEqual([])
  })
})

describe('shownTurn', () => {
  it('should detail a turn and the turns it sits under', () => {
    const shown = turn.shownTurn(session.sessionCache(), 'ses-me', 'm-me-1', null)

    expect(shown.selected).toBeNull()
    expect(shown.path).toEqual(new Set(['m-me-1']))
    expect(shown.turn).toMatchObject({
      id: 'm-me-1',
      sessionId: 'ses-me',
      agent: 'Claude',
      number: 1,
      durationMs: 4 * MINUTE,
      modelMs: 2 * MINUTE,
      toolMs: MINUTE,
    })
    expect(shown.turn.steps).toHaveLength(9)
    expect(shown.turn.nestedSteps).toBe(1)
    expect(shown.turn.context).toMatchObject({ isSame: false })
  })

  it('should tell the agent a call started inside the step that started it', () => {
    const { turn: shown } = turn.shownTurn(session.sessionCache(), 'ses-me', 'm-me-1', null)
    const spawn = shown.steps.find((step) => step.id === 'c-spawn')

    expect(spawn).toMatchObject({
      kind: 'tool',
      name: 'Task',
      started: { sessionId: 'ses-agent', agent: 'reviewer', failed: 0 },
    })
  })

  it('should say what the selected step needs: how many failed alike', () => {
    const shown = turn.shownTurn(session.sessionCache(), 'ses-me', 'm-me-1', 'c-edit-1')

    expect(shown.selected).toEqual({ id: 'c-edit-1', usualMs: null, isSlow: false, sameCauseFailures: 1 })
  })

  it('should refuse a turn the conversation does not have, and a step the turn does not have', () => {
    const cache = session.sessionCache()

    expect(() => turn.shownTurn(cache, 'ses-script', 'm-me-1', null)).toThrow('This conversation has no turn m-me-1')
    expect(() => turn.shownTurn(cache, 'ses-me', 'm-me-1', 'c-none')).toThrow('This turn has no step c-none')
  })
})

describe('sessionPlugins', () => {
  it('should list the plugin tools a session called where the harness recorded no offers', () => {
    const view = plugins.sessionPlugins(session.sessionCache(), 'ses-me')

    expect(view).toEqual({
      offers: 'unknown',
      definitions: 'recorded',
      plugins: [{ plugin: 'opencode', tools: [{ name: 'notes_add', calls: 1, definitionTokens: 100 }] }],
    })
  })
})
