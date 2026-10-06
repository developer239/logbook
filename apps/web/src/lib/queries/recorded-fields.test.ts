import type { IBuiltDemo } from '@log-book/demo'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import {
  allTime,
  callRowsOf,
  failedCallsOf,
  idOf,
  ownStepsOf,
  purposeLabelOf,
  sessionWith,
  stepsOf,
  type TStep,
} from '../../../test/plan-facts'
import { tokensOf } from '../context'
import { typical } from '../format'
import { causeOf } from '../labels'
import { calledPlugins } from '../plugins'
import { copyDemo, insert, type ITestWarehouse } from '../testing/warehouse'
import { HOUR, SECOND } from '../time'
import type * as Calls from './calls'
import type * as PluginsView from './plugins-view'
import type * as Problems from './problems'
import type * as Session from './session'
import type * as Steps from './steps'
import type * as ToolTokens from './tool-tokens'

let demo: IBuiltDemo
let warehouse: ITestWarehouse
let calls: typeof Calls
let tokens: typeof ToolTokens
let plugins: typeof PluginsView
let problems: typeof Problems
let sessions: typeof Session
let steps: typeof Steps

interface IRecordedCall {
  id: string
  name: string
  bare_name: string
  server: string | null
  family: string
  started_at: number
}

// Odd rows on top of the copy, in a session of their own: each call that waits on something by design (every dispatch
// and wait call, a started agent and a shell call waiting for something), and a plain read as the control, copied with
// enough quick runs to have a usual time and one run of an hour, so a slow one would show. The copies keep the names,
// servers and families the adapters recorded.
const ODD_SESSION = 'odd-session'
const ODD_MESSAGE = `${ODD_SESSION}/m1`
const LONG_MS = HOUR
let waiting: IRecordedCall[] = []
let control: IRecordedCall | undefined
// The slow groups of the small set itself, before the odd rows: its planned slow test run.
let ownSlowKeys: string[] = []

const recordedCall = (id: string): IRecordedCall =>
  warehouse.db
    .prepare('SELECT id, name, bare_name, server, family, started_at FROM tool_call WHERE id = ?')
    .get(id) as IRecordedCall

const recordedOf = (isWanted: (step: TStep) => boolean): IRecordedCall[] =>
  callRowsOf(demo)
    .filter((placed) => isWanted(placed.step))
    .map((placed) => recordedCall(idOf(demo, placed.step.key)))

// The planned loads of the first planned skill, as the adapters recorded them, and the requests of the calls that
// loaded them. The odd load adds one more, as large as the first, with no call behind it.
const skillLoads = (): { name: string; chars: number[]; requestChars: number[] } => {
  const [first] = stepsOf(demo).flatMap((placed) => (placed.step.kind === 'skill' ? [placed.step] : []))
  if (first === undefined) {
    throw new Error('The small set plans no skill load')
  }
  const ids = stepsOf(demo).flatMap((placed) =>
    placed.step.kind === 'skill' && placed.step.name === first.name ? [idOf(demo, placed.step.key)] : []
  )
  return {
    name: first.name,
    chars: ids.map(
      (id) =>
        (
          warehouse.db
            .prepare(
              "SELECT json_extract(data_json, '$.chars') AS chars FROM event WHERE kind = 'skill-loaded' AND json_extract(data_json, '$.toolCallId') = ?"
            )
            .get(id) as { chars: number }
        ).chars
    ),
    requestChars: ids.map(
      (id) =>
        (
          warehouse.db.prepare('SELECT length(input_json) AS requestChars FROM tool_call WHERE id = ?').get(id) as {
            requestChars: number
          }
        ).requestChars
    ),
  }
}

beforeAll(async () => {
  demo = inject('demoSmall')
  warehouse = await copyDemo('demoSmall')
  ownSlowKeys = (await import('./calls')).slowCalls(allTime(demo)).groups.map((group) => group.key)
  // A module of its own for the tests, whose usual times are first read after the odd rows: rows this connection writes
  // leave its data version as it was, so a module that read them before would keep them.
  vi.resetModules()
  calls = await import('./calls')
  waiting = [
    ...recordedOf((step) => step.kind === 'call' && (step.family === 'dispatch' || step.family === 'wait')),
    ...recordedOf((step) => step.kind === 'spawn').slice(0, 1),
    ...recordedOf((step) => step.kind === 'call' && purposeLabelOf(demo, step) === 'wait for something').slice(0, 1),
  ]
  ;[control] = recordedOf((step) => step.kind === 'call' && step.family === 'read')
  if (control === undefined) {
    throw new Error('The small set plans no read call')
  }
  const start = control.started_at
  insert(warehouse.db, 'session', {
    id: ODD_SESSION,
    harness: control.id.split(':')[0] ?? '',
    source_id: ODD_SESSION,
    origin: 'interactive',
    is_scripted: 0,
    started_at: start,
    ended_at: start + 2 * LONG_MS,
  })
  insert(warehouse.db, 'message', {
    id: ODD_MESSAGE,
    session_id: ODD_SESSION,
    seq: 0,
    actor: 'assistant',
    source_role: 'assistant',
    created_at: start,
  })
  for (const call of [...waiting, control]) {
    for (let run = 0; run <= calls.USUAL_MIN_CALLS; run += 1) {
      const id = `${call.id}/copy-${String(run)}`
      const at = start + run * SECOND
      insert(warehouse.db, 'tool_call', {
        id,
        session_id: ODD_SESSION,
        message_id: ODD_MESSAGE,
        name: call.name,
        bare_name: call.bare_name,
        server: call.server,
        family: call.family,
        input_json: '{}',
        status: 'completed',
        started_at: at,
        ended_at: at + (run === calls.USUAL_MIN_CALLS ? LONG_MS : SECOND),
      })
      if (call.family === 'shell') {
        insert(warehouse.db, 'label', {
          record_type: 'tool_call',
          record_id: id,
          labeller: 'rules',
          version: 1,
          name: 'purpose',
          value: 'wait for something',
          labelled_at: at,
        })
      }
    }
  }
  const loads = skillLoads()
  insert(warehouse.db, 'event', {
    id: `${ODD_SESSION}/skill`,
    session_id: ODD_SESSION,
    kind: 'skill-loaded',
    at: start,
    data_json: JSON.stringify({ name: loads.name, chars: loads.chars[0], toolCallId: null }),
  })
  tokens = await import('./tool-tokens')
  plugins = await import('./plugins-view')
  problems = await import('./problems')
  sessions = await import('./session')
  steps = await import('./steps')
})

afterAll(async () => {
  await warehouse.remove()
})

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

const slowKeyOf = (call: IRecordedCall): string =>
  calls.slowKey({
    name: call.bare_name,
    family: call.family,
    purpose: call.family === 'shell' ? 'wait for something' : null,
  })

const isDispatchOrWait = (call: IRecordedCall): boolean => call.family === 'dispatch' || call.family === 'wait'

describe('tools by their recorded server and name', () => {
  it('groups a call under the server it recorded, by its name without the server', () => {
    const served = recordedOf((step) => step.kind === 'call' && step.server !== null)

    const plugin = tokens.toolTokens(allTime(demo)).filter((row) => row.source.kind === 'plugin')

    expect({
      rows: plugin.map((row) => `${row.source.name} ${row.name}`).toSorted(),
      isDispatchOrWait: served.some(isDispatchOrWait),
    }).toStrictEqual({
      rows: [...new Set(served.map((call) => `${call.server ?? ''} ${call.bare_name}`))].toSorted(),
      isDispatchOrWait: true,
    })
  })

  it('lists a dispatch or wait call without a server under its own name with the harness tools', () => {
    const unserved = waiting.filter((call) => isDispatchOrWait(call) && call.server === null)

    const builtIn = tokens
      .toolTokens(allTime(demo))
      .filter((row) => row.source.kind === 'built-in')
      .map((row) => row.name)

    expect({
      isEachBuiltIn: unserved.every((call) => builtIn.includes(call.bare_name)),
      families: [...new Set(unserved.map((call) => call.family))].toSorted(),
    }).toStrictEqual({ isEachBuiltIn: true, families: ['dispatch', 'wait'] })
  })

  it("names a session's called plugin tool by its server in the plugin block", () => {
    const served = waiting.find((call) => isDispatchOrWait(call) && call.server !== null)
    const sessionKey = demo.plan.plan.sessions.find((session) =>
      ownStepsOf(demo, session.key).some((step) => served !== undefined && idOf(demo, step.key) === served.id)
    )?.key
    if (served === undefined || sessionKey === undefined) {
      throw new Error('The small set plans no dispatch or wait call under a server')
    }
    const own = recordedOf((step) => step.kind === 'call' && ownStepsOf(demo, sessionKey).includes(step))

    const view = plugins.sessionPlugins(sessions.sessionCache(), idOf(demo, sessionKey))

    expect(view).toStrictEqual({
      offers: 'unknown',
      definitions: 'unrecorded',
      plugins: calledPlugins(
        own.flatMap((call) =>
          call.server === null ? [] : [{ name: call.bare_name, plugin: call.server, calls: 1, definitionTokens: null }]
        )
      ),
    })
  })

  it('shows the offered tools of a session that recorded them, whatever its harness', () => {
    const offered = sessionWith(demo, (step) => step.kind === 'event' && step.event.type === 'tools-offered')
    const served = waiting.find((call) => call.server !== null)?.id ?? ''
    const called = demo.plan.plan.sessions.find((session) =>
      ownStepsOf(demo, session.key).some((step) => idOf(demo, step.key) === served)
    )?.key

    expect([
      plugins.sessionPlugins(sessions.sessionCache(), idOf(demo, offered)).offers,
      plugins.sessionPlugins(sessions.sessionCache(), idOf(demo, called ?? '')).offers,
    ]).toStrictEqual(['recorded', 'unknown'])
  })
})

describe('slow calls by family', () => {
  it('never counts a dispatch, wait, subagent or waiting shell call as slow, however long it ran', () => {
    const { groups } = calls.slowCalls(allTime(demo))

    expect({
      keys: groups.map((group) => group.key).toSorted(),
      families: [...new Set(waiting.map((call) => call.family))].toSorted(),
      isOwnSlow: ownSlowKeys.length > 0,
    }).toStrictEqual({
      keys: [...ownSlowKeys, control === undefined ? '' : slowKeyOf(control)].toSorted(),
      families: ['dispatch', 'shell', 'subagent', 'wait'],
      isOwnSlow: true,
    })
  })

  it('lists none of those calls as slow on /steps, and the long plain call as the only one', () => {
    const asked = [...(control === undefined ? [] : [control]), ...waiting]

    const totals = asked.map(
      (call) =>
        steps.steps(steps.parseStepsQuery(new URLSearchParams({ slow: slowKeyOf(call) })), allTime(demo), 0).total
    )

    expect(totals).toStrictEqual(asked.map((call) => (call === control ? 1 : 0)))
  })
})

describe('skill loads', () => {
  it('counts each skill-loaded event as a load with its chars, whether a call loaded it or not', () => {
    const loads = skillLoads()
    const chars = [...loads.chars, loads.chars[0] ?? 0]

    const skill = tokens
      .toolTokens(allTime(demo))
      .find((row) => row.source.kind === 'skills' && row.name === loads.name)

    expect(skill).toMatchObject({
      name: loads.name,
      calls: chars.length,
      typicalTokens: tokensOf(typical(chars)),
      totalTokens: tokensOf(sum(chars) + sum(loads.requestChars)),
    })
  })
})

describe('tool problems', () => {
  it('counts a failed dispatch or wait call under its cause, with no list of tools you maintain', () => {
    const failed = failedCallsOf(demo).find((call) => call.family === 'dispatch' || call.family === 'wait')
    if (failed === undefined) {
      throw new Error('The small set plans no failed dispatch or wait call')
    }
    const cause = causeOf(failed.family, failed.label)

    const found = problems.toolProblems(allTime(demo))

    expect({
      keys: Object.keys(found).toSorted(),
      isUnderCause: found.causes.find((row) => row.cause === cause)?.tools.includes(recordedCall(failed.id).bare_name),
    }).toStrictEqual({ keys: ['causes', 'failed', 'realResults'], isUnderCause: true })
  })
})
