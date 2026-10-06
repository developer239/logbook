import type { IBuiltDemo } from '@log-book/demo'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import {
  callsOf,
  failedCallsOf,
  failureLabelOf,
  familyOf,
  firstPromptOf,
  harnessOf,
  idOf,
  isFailed,
  ownStepsOf,
  plannedLabel,
  plannedSession,
  promptBefore,
  purposeLabelOf,
  reactionsOf,
  sessionWith,
  type TCallStep,
  type TStep,
} from '../../../test/plan-facts'
import { tokensOf } from '../context'
import { byPressure, causeOf } from '../labels'
import { copyDemo, insert, type ITestWarehouse } from '../testing/warehouse'
import { USUAL_MIN_CALLS } from './calls'
import type * as Plugins from './plugins-view'
import type * as Session from './session'
import type * as Thread from './thread'
import type * as Turn from './turn'

let demo: IBuiltDemo
let warehouse: ITestWarehouse
let session: typeof Session
let thread: typeof Thread
let turn: typeof Turn
let plugins: typeof Plugins

// An odd row on top of the copy: an MCP call in a conversation that recorded no tools on offer.
const UNOFFERED_CALL = 'unoffered-call'
const UNOFFERED_SERVER = 'notes'

type TSpawnStep = Extract<TStep, { kind: 'spawn' }>

const isSpawn = (step: TStep): step is TSpawnStep => step.kind === 'spawn'
const hasReactions = (step: TStep): boolean => step.kind === 'prompt' && reactionsOf(demo, step.key).length > 1
const isEventOf =
  (type: string) =>
  (step: TStep): boolean =>
    step.kind === 'event' && step.event.type === type

// A spawn whose call recorded the session it started: OpenCode records only the session that started one, so the pages
// cannot place it under a turn.
const isLinkedSpawn = (step: TStep): boolean =>
  isSpawn(step) &&
  (
    warehouse.db.prepare('SELECT child_session_id FROM tool_call WHERE id = ?').get(idOf(demo, step.key)) as
      | { child_session_id: string | null }
      | undefined
  )?.child_session_id !== null

const spawning = (): string => sessionWith(demo, isLinkedSpawn)

const reacting = (): string => sessionWith(demo, hasReactions)

const spawnOf = (key: string): TSpawnStep => {
  const spawn = ownStepsOf(demo, key).filter(isSpawn).find(isLinkedSpawn)
  if (spawn === undefined) {
    throw new Error(`${key} plans no spawn`)
  }
  return spawn
}

const calls = (key: string): TCallStep[] => ownStepsOf(demo, key).filter((step) => step.kind === 'call')

const defaultAgentOf = (harness: string): string =>
  (warehouse.db.prepare('SELECT default_agent FROM harness WHERE id = ?').get(harness) as { default_agent: string })
    .default_agent

beforeAll(async () => {
  demo = inject('demoSmall')
  warehouse = await copyDemo('demoSmall')
  const reactingId = idOf(demo, reacting())
  const { message_id: messageId, started_at: at } = warehouse.db
    .prepare('SELECT message_id, started_at FROM tool_call WHERE session_id = ? ORDER BY started_at LIMIT 1')
    .get(reactingId) as { message_id: string; started_at: number }
  insert(warehouse.db, 'tool_call', {
    id: UNOFFERED_CALL,
    session_id: reactingId,
    message_id: messageId,
    name: 'take_note',
    bare_name: 'take_note',
    server: UNOFFERED_SERVER,
    family: `mcp:${UNOFFERED_SERVER}`,
    input_json: '{}',
    status: 'completed',
    started_at: at,
    ended_at: at,
  })
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
    const key = spawning()
    const spawn = spawnOf(key)
    const models = ownStepsOf(demo, key).flatMap((step) => (step.kind === 'reply' ? [step.model] : []))
    const [mainModel] = [...Map.groupBy(models, (model) => model)].toSorted(
      (left, right) => right[1].length - left[1].length
    )

    const read = session.sessionOf(session.sessionCache(), idOf(demo, key))

    expect({
      head: { id: read.id, harness: read.harness, agent: read.agent, model: read.model, outcome: read.outcome },
      turns: read.turns.map((row) => row.id),
      tools: read.tools.map((tool) => tool.id).toSorted(),
      spawnTurn: read.turns.find((row) => row.tools.some((tool) => tool.id === idOf(demo, spawn.key)))?.id,
    }).toStrictEqual({
      head: {
        id: idOf(demo, key),
        harness: harnessOf(demo, key),
        agent: plannedSession(demo, key).agent,
        model: mainModel?.[0],
        outcome: plannedLabel(demo, key, 'outcome'),
      },
      // A turn opens with each prompt and each command the human typed.
      turns: ownStepsOf(demo, key).flatMap((step) =>
        step.kind === 'prompt' || step.kind === 'command' ? [idOf(demo, step.key)] : []
      ),
      tools: ownStepsOf(demo, key)
        .flatMap((step) =>
          step.kind === 'call' || step.kind === 'spawn' || step.kind === 'skill' ? [idOf(demo, step.key)] : []
        )
        .toSorted(),
      spawnTurn: idOf(demo, promptBefore(demo, key, spawn.key)),
    })
  })

  it('should read what a message cost the model to read and to write', () => {
    const key = spawning()
    const prompt = firstPromptOf(demo, key)
    const reply = ownStepsOf(demo, key).find((step) => step.kind === 'reply' && step.tokens !== null)
    if (reply?.kind !== 'reply' || reply.tokens === null) {
      throw new Error(`${key} plans no reply with tokens`)
    }

    const read = session.sessionOf(session.sessionCache(), idOf(demo, key))

    expect({
      prompt: read.messageById.get(idOf(demo, prompt.key)),
      reply: read.messageById.get(idOf(demo, reply.key)),
    }).toMatchObject({
      prompt: { tokensRead: null, tokensWritten: null, text: prompt.text },
      reply: {
        tokensRead: (reply.tokens.input ?? 0) + (reply.tokens.cacheRead ?? 0) + (reply.tokens.cacheWrite ?? 0),
        tokensWritten: reply.tokens.output,
      },
    })
  })

  it('should read the summary a compaction left', () => {
    const key = sessionWith(demo, isEventOf('compaction'))
    const summaries = ownStepsOf(demo, key).flatMap((step) =>
      step.kind === 'event' && step.event.type === 'compaction' ? [step.event.summary] : []
    )

    const read = session.sessionOf(session.sessionCache(), idOf(demo, key))

    expect(read.messages.flatMap((message) => message.compactionSummary ?? [])).toStrictEqual(summaries)
  })

  it('should read a call with its result, its labels and its time', () => {
    const failed = failedCallsOf(demo).find(
      (call) => call.family === 'shell' && call.step.status === 'error' && call.label !== null
    )
    if (failed === undefined) {
      throw new Error('The small set plans no labelled failed shell call')
    }
    // What the adapter recorded of the call, which the plan states in no harness's words.
    const recorded = warehouse.db
      .prepare('SELECT message_id, name, bare_name, input_json FROM tool_call WHERE id = ?')
      .get(failed.id) as { message_id: string; name: string; bare_name: string; input_json: string }

    const read = session.sessionOf(session.sessionCache(), idOf(demo, failed.sessionKey))

    expect(read.tools.find((tool) => tool.id === failed.id)).toStrictEqual({
      id: failed.id,
      messageId: recorded.message_id,
      name: recorded.name,
      bareName: recorded.bare_name,
      server: null,
      family: 'shell',
      status: 'error',
      inputJson: recorded.input_json,
      startedAt: failed.step.startAt,
      endedAt: failed.step.endAt,
      output: failed.step.result,
      purpose: purposeLabelOf(demo, failed.step),
      label: failureLabelOf(demo, failed.step),
    })
  })

  it('should count calls by name, and the reactions in its prompts and the agents it started', () => {
    const key = spawning()
    const spawn = spawnOf(key)
    const under = idOf(demo, promptBefore(demo, key, spawn.key))
    const child = {
      sessionId: idOf(demo, spawn.child.key),
      turnId: idOf(demo, firstPromptOf(demo, spawn.child.key).key),
    }
    const cache = session.sessionCache()

    const read = session.sessionOf(cache, idOf(demo, key))
    const { reactions } = session.sessionOf(cache, idOf(demo, reacting()))

    expect({
      calls: [...read.callsByName.values()].reduce((total, count) => total + count, 0),
      reactions,
      childrenOfTurn: read.childrenOfTurn.get(under),
      childrenOfCall: read.childrenOfCall.get(idOf(demo, spawn.key)),
    }).toStrictEqual({
      calls: read.tools.length,
      reactions: new Map(
        ownStepsOf(demo, reacting()).flatMap((step) =>
          step.kind === 'prompt' && reactionsOf(demo, step.key).length > 0
            ? [[idOf(demo, step.key), byPressure(reactionsOf(demo, step.key))]]
            : []
        )
      ),
      childrenOfTurn: [{ ...child, under }],
      childrenOfCall: [{ ...child, under: idOf(demo, spawn.key) }],
    })
  })

  it('should read the size of a tool definition the harness recorded', () => {
    const key = sessionWith(demo, isEventOf('tools-loaded'))
    const loaded = ownStepsOf(demo, key).flatMap((step) =>
      step.kind === 'event' && step.event.type === 'tools-loaded' ? step.event.tools : []
    )
    const chars = new Map(
      (
        warehouse.db
          .prepare(
            `SELECT json_extract(t.value, '$.name') AS name, json_extract(t.value, '$.chars') AS chars
             FROM event e, json_each(e.data_json, '$.tools') t WHERE e.session_id = ? AND e.kind = 'tools-loaded'`
          )
          .all(idOf(demo, key)) as { name: string; chars: number }[]
      ).map((row) => [row.name, row.chars])
    )

    const read = session.sessionOf(session.sessionCache(), idOf(demo, key))

    expect(read.definitionTokens).toStrictEqual(
      new Map(loaded.map((tool) => [tool.name, tokensOf(chars.get(tool.name) ?? 0)]))
    )
  })

  it('should read a session once for a page', () => {
    const cache = session.sessionCache()
    const id = idOf(demo, spawning())

    expect(session.sessionOf(cache, id)).toBe(session.sessionOf(cache, id))
  })

  it('should refuse a session the warehouse does not have', () => {
    expect(() => session.sessionOf(session.sessionCache(), 'ses-none')).toThrow('No session ses-none')
  })
})

describe('thread', () => {
  it('should lay a conversation out turn by turn, each prompt with its reactions', () => {
    const key = reacting()
    const prompts = ownStepsOf(demo, key).filter((step) => step.kind === 'prompt')
    // A turn's failed calls are those after its prompt and before the next.
    const failedIn = (prompt: string): number => {
      const steps = ownStepsOf(demo, key)
      const start = steps.findIndex((step) => step.key === prompt)
      const end = steps.findIndex((step, index) => index > start && step.kind === 'prompt')
      return steps.slice(start, end === -1 ? undefined : end).filter((step) => step.kind === 'call' && isFailed(step))
        .length
    }

    const { agent, turns } = thread.thread(session.sessionCache(), idOf(demo, key))

    expect({ agent, turns: turns.map((row) => [row.number, row.prompt, row.failed]) }).toStrictEqual({
      agent: plannedSession(demo, key).agent ?? defaultAgentOf(harnessOf(demo, key)),
      turns: prompts.map((prompt, index) => [
        index + 1,
        { text: prompt.text, reactions: byPressure(reactionsOf(demo, prompt.key)) },
        failedIn(prompt.key),
      ]),
    })
  })

  it('should show the reply that ended a turn, and the compactions in it', () => {
    const key = sessionWith(demo, isEventOf('compaction'))
    const steps = ownStepsOf(demo, key)
    const compaction = steps.find(isEventOf('compaction'))
    const prompt = compaction === undefined ? undefined : promptBefore(demo, key, compaction.key)
    const lastReply = steps.findLast((step) => step.kind === 'reply' && step.text !== null)
    if (compaction?.kind !== 'event' || compaction.event.type !== 'compaction' || lastReply?.kind !== 'reply') {
      throw new Error(`${key} plans no compaction or reply`)
    }

    const { turns } = thread.thread(session.sessionCache(), idOf(demo, key))

    expect({
      compactions: turns.find((row) => row.id === idOf(demo, prompt ?? ''))?.compactions,
      reply: turns.at(-1)?.reply,
    }).toStrictEqual({
      compactions: [{ at: compaction.at, summary: compaction.event.summary }],
      reply: { text: lastReply.text, model: lastReply.model, at: lastReply.endAt },
    })
  })

  it('should show an agent a turn started with only the turns placed there', () => {
    const key = spawning()
    const spawn = spawnOf(key)
    const child = spawn.child.key

    const { turns } = thread.thread(session.sessionCache(), idOf(demo, key))
    const spawned = turns.find((row) => row.id === idOf(demo, promptBefore(demo, key, spawn.key)))?.spawned

    expect({
      spawned: spawned?.map(({ turns: childTurns, ...ref }) => ({
        ...ref,
        prompts: childTurns.map((row) => row.prompt?.text),
      })),
    }).toMatchObject({
      spawned: [
        {
          sessionId: idOf(demo, child),
          underTurnId: idOf(demo, promptBefore(demo, key, spawn.key)),
          agent: plannedSession(demo, child).agent ?? spawn.agentType,
          harness: harnessOf(demo, child),
          outcome: plannedLabel(demo, child, 'outcome'),
          failed: calls(child).filter(isFailed).length,
          prompts: ownStepsOf(demo, child).flatMap((step) => (step.kind === 'prompt' ? [step.text] : [])),
        },
      ],
    })
  })

  it('should show no harness message as a prompt, only as a harness line', () => {
    const key = sessionWith(demo, (step) => step.kind === 'command')
    const command = ownStepsOf(demo, key).find((step) => step.kind === 'command')
    if (command?.kind !== 'command') {
      throw new Error(`${key} plans no command`)
    }

    const { turns } = thread.thread(session.sessionCache(), idOf(demo, key))
    const opened = turns.find((row) => row.harnessLines.some((line) => line.includes(command.name)))

    expect({ prompt: opened?.prompt, isOpened: opened !== undefined }).toStrictEqual({ prompt: null, isOpened: true })
  })
})

describe('shownTurn', () => {
  it('should detail a turn and the turns it sits under', () => {
    const key = spawning()
    const under = promptBefore(demo, key, spawnOf(key).key)
    const row = warehouse.db
      .prepare('SELECT seq, started_at, ended_at, model_ms, tool_ms FROM turn WHERE message_id = ?')
      .get(idOf(demo, under)) as {
      seq: number
      started_at: number
      ended_at: number
      model_ms: number
      tool_ms: number
    }
    const spawned = thread
      .thread(session.sessionCache(), idOf(demo, key))
      .turns.find((threadTurn) => threadTurn.id === idOf(demo, under))?.spawned

    const shown = turn.shownTurn(session.sessionCache(), idOf(demo, key), idOf(demo, under), null)

    expect({
      selected: shown.selected,
      path: shown.path,
      turn: {
        id: shown.turn.id,
        sessionId: shown.turn.sessionId,
        number: shown.turn.number,
        durationMs: shown.turn.durationMs,
        modelMs: shown.turn.modelMs,
        toolMs: shown.turn.toolMs,
        nestedSteps: shown.turn.nestedSteps,
      },
    }).toStrictEqual({
      selected: null,
      path: new Set([idOf(demo, under)]),
      turn: {
        id: idOf(demo, under),
        sessionId: idOf(demo, key),
        number: row.seq + 1,
        durationMs: row.ended_at - row.started_at,
        modelMs: row.model_ms,
        toolMs: row.tool_ms,
        nestedSteps: (spawned ?? []).reduce((total, agent) => total + agent.steps, 0),
      },
    })
  })

  it('should tell the agent a call started inside the step that started it', () => {
    const key = spawning()
    const spawn = spawnOf(key)

    const { turn: shown } = turn.shownTurn(
      session.sessionCache(),
      idOf(demo, key),
      idOf(demo, promptBefore(demo, key, spawn.key)),
      null
    )

    expect(shown.steps.find((step) => step.id === idOf(demo, spawn.key))).toMatchObject({
      kind: 'tool',
      started: {
        sessionId: idOf(demo, spawn.child.key),
        agent: plannedSession(demo, spawn.child.key).agent ?? spawn.agentType,
        failed: calls(spawn.child.key).filter(isFailed).length,
      },
    })
  })

  it('should say what the selected step needs: how many failed alike', () => {
    const failed = failedCallsOf(demo)
    const selected = failed.find(
      (call) =>
        call.family !== 'shell' &&
        causeOf(call.family, call.label) !== null &&
        callsOf(demo).filter((other) => familyOf(other.step) === call.family).length < USUAL_MIN_CALLS
    )
    if (selected === undefined) {
      throw new Error('The small set plans no failed call with a cause')
    }
    const cause = causeOf(selected.family, selected.label)

    const shown = turn.shownTurn(
      session.sessionCache(),
      idOf(demo, selected.sessionKey),
      idOf(demo, promptBefore(demo, selected.sessionKey, selected.step.key)),
      selected.id
    )

    expect(shown.selected).toStrictEqual({
      id: selected.id,
      usualMs: null,
      isSlow: false,
      sameCauseFailures: failed.filter((call) => causeOf(call.family, call.label) === cause).length,
    })
  })

  it('should refuse a turn the conversation does not have, and a step the turn does not have', () => {
    const key = spawning()
    const other =
      demo.plan.plan.sessions.find((planned) => planned.parentKey === null && planned.key !== key)?.key ?? ''
    const turnId = idOf(demo, firstPromptOf(demo, key).key)
    const cache = session.sessionCache()

    expect(() => turn.shownTurn(cache, idOf(demo, other), turnId, null)).toThrow(
      `This conversation has no turn ${turnId}`
    )
    expect(() => turn.shownTurn(cache, idOf(demo, key), turnId, 'c-none')).toThrow('This turn has no step c-none')
  })
})

describe('sessionPlugins', () => {
  it('should list the servers a session recorded on offer, with those that failed at the start', () => {
    const key = sessionWith(demo, isEventOf('tools-offered'))
    const failedServers = ownStepsOf(demo, key).flatMap((step) =>
      step.kind === 'event' && step.event.type === 'tools-offered' ? step.event.failedServers : []
    )

    const view = plugins.sessionPlugins(session.sessionCache(), idOf(demo, key))

    expect({
      offers: view.offers,
      failed:
        view.offers === 'recorded'
          ? view.servers
              .filter((server) => server.startState === 'failed')
              .map((server) => ({ name: server.name, error: server.error }))
          : [],
      isAny: failedServers.length > 0,
    }).toStrictEqual({
      offers: 'recorded',
      failed: failedServers.map((server) => ({ name: server.name, error: server.error })),
      isAny: true,
    })
  })

  it('should list the plugin tools a session called where the harness recorded no offers', () => {
    const view = plugins.sessionPlugins(session.sessionCache(), idOf(demo, reacting()))

    expect(view).toStrictEqual({
      offers: 'unknown',
      definitions: 'unrecorded',
      plugins: [{ plugin: UNOFFERED_SERVER, tools: [{ name: 'take_note', calls: 1, definitionTokens: null }] }],
    })
  })
})
