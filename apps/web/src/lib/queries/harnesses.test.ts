import type { ISqliteDb } from '@log-book/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseFilter } from '../filter'
import type * as Labels from '../labels'
import { parseRange } from '../range'
import { emptyWarehouse, insert, type ITestWarehouse } from '../testing/warehouse'
import { MINUTE } from '../time'
import type * as Conversations from './conversations'
import type * as HarnessQueries from './harnesses'
import type * as Session from './session'
import type * as Thread from './thread'

const START = Date.UTC(2026, 8, 14, 10)

// Two invented harnesses, a session of each, and one of a harness no sync described.
const seed = (db: ISqliteDb): void => {
  for (const [id, name, agent, alias] of [
    ['example', 'Example Harness', 'helper', 'ex'],
    ['sample', 'Sample Harness', 'worker', 'sa'],
  ] as const) {
    insert(db, 'harness', {
      id,
      name,
      default_agent: agent,
      filter_alias: alias,
      is_found: 1,
      checked_at: START,
      location_variables: '[]',
    })
  }
  for (const [id, of, agent] of [
    ['example:demo-0001', 'example', null],
    ['sample:demo-0001', 'sample', 'reviewer'],
    ['ghost:demo-0001', 'ghost', null],
  ] as const) {
    insert(db, 'session', {
      id,
      harness: of,
      source_id: 'demo-0001',
      origin: 'interactive',
      is_scripted: 0,
      title: `Work in ${of}`,
      agent,
      started_at: START,
      ended_at: START + MINUTE,
    })
    for (const [seq, actor, text] of [
      [0, 'user', 'Rename the release script'],
      [1, 'assistant', 'Done.'],
    ] as const) {
      const messageId = `${id}/m${String(seq + 1)}`
      insert(db, 'message', {
        id: messageId,
        session_id: id,
        seq,
        actor,
        source_role: actor,
        created_at: START + seq * 1000,
      })
      insert(db, 'part', { message_id: messageId, session_id: id, idx: 0, kind: 'text', text })
    }
  }
}

let warehouse: ITestWarehouse
let harnesses: typeof HarnessQueries
let list: typeof Conversations
let sessions: typeof Session
let threads: typeof Thread
let labels: typeof Labels

beforeAll(async () => {
  warehouse = await emptyWarehouse()
  seed(warehouse.db)
  harnesses = await import('./harnesses')
  list = await import('./conversations')
  sessions = await import('./session')
  threads = await import('./thread')
  labels = await import('../labels')
})

afterAll(async () => {
  await warehouse.remove()
})

const idsOf = (query: string): string[] =>
  list
    .conversations(parseFilter(query), parseRange(new URLSearchParams('range=all'), START), 0, harnesses.harnessesOf())
    .rows.map((row) => row.id)
    .toSorted()

describe('harnessesOf', () => {
  it('should read every descriptor row by its id', () => {
    // Act
    const read = harnesses.harnessesOf()

    // Assert
    expect([...read.values()]).toStrictEqual([
      {
        id: 'example',
        name: 'Example Harness',
        defaultAgent: 'helper',
        filterAlias: 'ex',
        isFound: true,
        location: null,
        locationVariables: [],
        problem: null,
      },
      {
        id: 'sample',
        name: 'Sample Harness',
        defaultAgent: 'worker',
        filterAlias: 'sa',
        isFound: true,
        location: null,
        locationVariables: [],
        problem: null,
      },
    ])
  })
})

describe('the harness filter', () => {
  it("should list a harness's sessions by its alias or its id, and none for an unknown value", () => {
    // Act
    const found = [idsOf('harness:ex'), idsOf('harness:example'), idsOf('harness:nope')]

    // Assert
    expect(found).toStrictEqual([['example:demo-0001'], ['example:demo-0001'], []])
  })
})

describe('the agent of a session', () => {
  it("should be the descriptor's default agent for a session that names none, and the session's own otherwise", () => {
    // Arrange
    const cache = sessions.sessionCache()

    // Act
    const agents = [threads.thread(cache, 'example:demo-0001').agent, threads.thread(cache, 'sample:demo-0001').agent]

    // Assert
    expect(agents).toStrictEqual(['helper', 'reviewer'])
  })

  it('should name a harness no row describes by its id, and still read its thread', () => {
    // Arrange
    const cache = sessions.sessionCache()

    // Act
    const own = threads.thread(cache, 'ghost:demo-0001')

    // Assert
    expect({ agent: own.agent, name: labels.harnessName(cache.harnesses, 'ghost') }).toStrictEqual({
      agent: 'ghost',
      name: 'ghost',
    })
  })
})
