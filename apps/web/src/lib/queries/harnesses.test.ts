import type { ISqliteDb } from '@log-book/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseFilter } from '../filter'
import type * as Labels from '../labels'
import { everything, harness, message, session, START } from '../testing/rows'
import { seedWarehouse, type ITestWarehouse } from '../testing/warehouse'
import { MINUTE } from '../time'
import type * as Conversations from './conversations'
import type * as HarnessQueries from './harnesses'
import type * as Session from './session'
import type * as Thread from './thread'

// Two invented harnesses, a session of each, and one of a harness no sync described.
const seed = (db: ISqliteDb): void => {
  harness(db, { id: 'example', name: 'Example Harness', defaultAgent: 'helper', filterAlias: 'ex' })
  harness(db, { id: 'sample', name: 'Sample Harness', defaultAgent: 'worker', filterAlias: 'sa' })
  for (const [id, of, agent] of [
    ['example:demo-0001', 'example', null],
    ['sample:demo-0001', 'sample', 'reviewer'],
    ['ghost:demo-0001', 'ghost', null],
  ] as const) {
    session(db, {
      id,
      harness: of,
      origin: 'interactive',
      title: `Work in ${of}`,
      ...(agent === null ? {} : { agent }),
      startedAt: START,
      endedAt: START + MINUTE,
    })
    message(db, { id: `${id}/m1`, sessionId: id, seq: 0, actor: 'user', at: START, text: 'Rename the release script' })
    message(db, { id: `${id}/m2`, sessionId: id, seq: 1, actor: 'assistant', at: START + 1000, text: 'Done.' })
  }
}

let warehouse: ITestWarehouse
let harnesses: typeof HarnessQueries
let list: typeof Conversations
let sessions: typeof Session
let threads: typeof Thread
let labels: typeof Labels

beforeAll(async () => {
  warehouse = await seedWarehouse(seed)
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
    .conversations(parseFilter(query), everything(), 0, harnesses.harnessesOf())
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
