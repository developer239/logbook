import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SOURCE_WRITER_ERROR_CODES } from '@log-book/adapter-api/source-writer'
import { claudeCodeSourceWriter } from '@log-book/adapter-claude-code/source-writer'
import { openCodeSourceWriter } from '@log-book/adapter-opencode/source-writer'
import { openSqlite } from '@log-book/core'
import { createTestWarehouse, insert } from '@log-book/warehouse/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { PLAN_CORPUS } from '../corpus/index.js'
import { MODELS } from '../corpus/models.js'
import { planLabels } from '../plan/labels.js'
import { planDataset } from '../plan/planner.js'
import { scriptPlan } from '../plan/scripts.js'
import type { IDemoPlan, IPlanInputs, IWriterDeclaration } from '../plan/types.js'
import { canonicalDump } from './canonical-dump.js'
import { MANIFEST_FILE, PLAN_FILE, writeDemo } from './write-demo.js'

const WRITERS = [claudeCodeSourceWriter(), openCodeSourceWriter()] as const
const DECLARATIONS: readonly IWriterDeclaration[] = [
  { capabilities: [...WRITERS[0].capabilities], families: [...WRITERS[0].families], models: MODELS['claude-code'] },
  { capabilities: [...WRITERS[1].capabilities], families: [...WRITERS[1].families], models: MODELS.opencode },
]
const INPUTS: IPlanInputs = {
  size: 'small',
  seed: 1,
  anchor: Date.UTC(2026, 8, 28, 18),
  labels: 'all',
  model: null,
  corpus: PLAN_CORPUS,
  writers: DECLARATIONS,
}

// How long the first writer goes on after the second refused, far longer than the refusal takes to reach the caller.
const STILL_WRITING_MS = 100

const directories: string[] = []

const temporary = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'demo-write-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

const demoPlan = (): IDemoPlan => {
  const plan = planDataset(INPUTS)
  const writers = scriptPlan(plan, INPUTS)
  return { plan, writers, labels: planLabels(plan, writers, PLAN_CORPUS), ids: {}, showcase: null }
}

const filesUnder = async (directory: string): Promise<string[]> =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))

const sorted = (values: readonly string[]): string[] => values.toSorted((left, right) => (left < right ? -1 : 1))

const read = async (out: string): Promise<{ plan: string; manifest: string; files: string[] }> => ({
  plan: await readFile(join(out, PLAN_FILE), 'utf8'),
  manifest: await readFile(join(out, MANIFEST_FILE), 'utf8'),
  files: sorted(await filesUnder(out)),
})

const ROWS = [
  ['b', 2],
  ['a', 1],
  ['c', 3],
] as const

const database = async (rows: readonly (readonly [string, number])[]): Promise<string> => {
  const path = join(await temporary(), 'data.db')
  const db = await openSqlite(path, { isReadOnly: false })
  db.exec('CREATE TABLE item (name TEXT PRIMARY KEY, size INTEGER) STRICT; CREATE TABLE note (text TEXT)')
  for (const [name, size] of rows) {
    insert(db, 'item', { name, size })
    insert(db, 'note', { text: name })
  }
  db.close()
  return path
}

describe('writeDemo', () => {
  it('gives byte-identical plan.json and manifest.json and equal files for two writes of the same plan', async () => {
    // Arrange
    const [first, second] = [await temporary(), await temporary()]

    // Act
    await writeDemo(first, demoPlan(), WRITERS)
    await writeDemo(second, demoPlan(), WRITERS)
    // Assert
    expect(await read(second)).toStrictEqual(await read(first))
  })

  it('lists in the manifest exactly the files under home and plan.json, each with a hash', async () => {
    // Arrange
    const out = await temporary()

    // Act
    const { manifest } = await writeDemo(out, demoPlan(), WRITERS)
    const listed = Object.keys(manifest.files)
    const onDisk = sorted(await filesUnder(out)).filter((file) => file !== MANIFEST_FILE)

    // Assert
    expect({
      listed,
      isHashed: Object.values(manifest.files).every((hash) => /^[0-9a-f]{64}$/u.test(hash)),
    }).toStrictEqual({ listed: onDisk, isHashed: true })
  })

  it('writes plan.json that reads back as the plan in memory, record ids included', async () => {
    // Arrange
    const out = await temporary()

    // Act
    const { plan } = await writeDemo(out, demoPlan(), WRITERS)
    const readBack = JSON.parse(await readFile(join(out, PLAN_FILE), 'utf8')) as unknown

    // Assert
    expect({ readBack, hasIds: Object.keys(plan.ids).length > 0 }).toStrictEqual({ readBack: plan, hasIds: true })
  })

  it('records the build, the corpus mark and the sorted session ids in the manifest', async () => {
    // Arrange
    const out = await temporary()

    // Act
    const { manifest, plan } = await writeDemo(out, demoPlan(), WRITERS)
    const topLevel = plan.plan.sessions.filter((session) => session.parentKey === null).length

    // Assert
    expect({
      build: manifest.build,
      isMarked: manifest.corpusMark.startsWith('log-book-demo-corpus-'),
      sessions: manifest.sessions.length,
      isSorted: manifest.sessions.join('\n') === sorted(manifest.sessions).join('\n'),
      areTextsSorted: manifest.texts.join('\n') === sorted(manifest.texts).join('\n'),
      topLevel,
    }).toStrictEqual({
      build: { size: 'small', seed: 1, labels: 'all', model: 'claude-haiku-4-5', anchor: '2026-09-28T18:00:00.000Z' },
      isMarked: true,
      sessions: plan.plan.sessions.length,
      isSorted: true,
      areTextsSorted: true,
      topLevel: 14,
    })
  })

  it('gives every plan key a label refers to a record id', async () => {
    // Arrange
    const out = await temporary()

    // Act
    const { plan } = await writeDemo(out, demoPlan(), WRITERS)
    const missing = plan.labels.labels.filter((label) => plan.ids[label.recordKey.split('#')[0] ?? ''] === undefined)

    // Assert
    expect({ labels: plan.labels.labels.length > 0, missing: missing.map((label) => label.recordKey) }).toStrictEqual({
      labels: true,
      missing: [],
    })
  })

  it("stops on a script a writer refuses, with the writer's error code and the script key", async () => {
    // Arrange
    const out = await temporary()
    const demo = demoPlan()
    const [, second] = demo.writers
    const [first] = demo.writers[0]?.scripts ?? []
    const broken = { ...demo, writers: [demo.writers[0], { ...second, scripts: first === undefined ? [] : [first] }] }

    // Act
    const write = writeDemo(out, broken as IDemoPlan, WRITERS)

    // Assert
    await expect(write).rejects.toMatchObject({
      code: SOURCE_WRITER_ERROR_CODES.WRITER_SCRIPT_UNSUPPORTED,
      message: expect.stringContaining(String(first?.key)) as unknown,
    })
  })

  it('throws a refusal only once every other writer has finished, so nothing is written after it', async () => {
    // Arrange
    const out = await temporary()
    const demo = demoPlan()
    const [, second] = demo.writers
    const [first] = demo.writers[0]?.scripts ?? []
    const broken = { ...demo, writers: [demo.writers[0], { ...second, scripts: first === undefined ? [] : [first] }] }
    const [claudeCode, openCode] = WRITERS
    // The first writer starts its sessions only a while after the second has refused, so it is still writing then.
    const { promise: refused, resolve: release } = Promise.withResolvers<undefined>()
    const slowSessions = async (
      home: string,
      scripts: Parameters<typeof claudeCode.writeSessions>[1]
    ): ReturnType<typeof claudeCode.writeSessions> => {
      await refused
      await delay(STILL_WRITING_MS)
      return claudeCode.writeSessions(home, scripts)
    }
    let firstWriting: Promise<unknown> = Promise.resolve()
    const writers = [
      {
        ...claudeCode,
        writeSessions: async (home: string, scripts: Parameters<typeof claudeCode.writeSessions>[1]) => {
          const writing = slowSessions(home, scripts)
          firstWriting = writing
          return writing
        },
      },
      {
        ...openCode,
        writeSessions: async (home: string, scripts: Parameters<typeof openCode.writeSessions>[1]) => {
          try {
            return await openCode.writeSessions(home, scripts)
          } finally {
            release(undefined)
          }
        },
      },
    ]

    // Act
    const rejection = await writeDemo(out, broken as IDemoPlan, writers).catch((error: unknown) => error)
    const filesAtRejection = sorted(await filesUnder(out))
    await firstWriting

    // Assert
    expect({
      code: (rejection as { code?: string }).code,
      isUnchangedSince: sorted(await filesUnder(out)).join('\n') === filesAtRejection.join('\n'),
    }).toStrictEqual({ code: SOURCE_WRITER_ERROR_CODES.WRITER_SCRIPT_UNSUPPORTED, isUnchangedSince: true })
  })
})

describe('canonicalDump', () => {
  it('gives the same dump for the same rows inserted in two orders, and another for a changed row', async () => {
    // Arrange
    const [forward, backward, changed] = [
      await database(ROWS),
      await database(ROWS.toReversed()),
      await database([...ROWS.slice(1), ['b', 20]]),
    ]

    // Act
    const dumps = await Promise.all([forward, backward, changed].map(async (path) => canonicalDump(path, 'sqlite')))

    // Assert
    expect({ isSame: dumps[0] === dumps[1], isChanged: dumps[0] !== dumps[2] }).toStrictEqual({
      isSame: true,
      isChanged: true,
    })
  })

  it("leaves a warehouse's dump as it was for part.rowid and the wall-clock columns, but not a model label's time", async () => {
    // Arrange
    const warehouse = await createTestWarehouse()
    const { db } = warehouse
    insert(db, 'harness', {
      id: 'demo',
      name: 'Demo',
      default_agent: 'build',
      filter_alias: 'demo',
      is_found: 1,
      checked_at: 1,
      location_variables: '{}',
    })
    insert(db, 'source_state', { harness: 'demo', locator: 'a', fingerprint: 'f', parser_version: 1, imported_at: 1 })
    insert(db, 'sync_run', { id: 1, started_at: 1, ended_at: 2, outcome: 'ok' })
    insert(db, 'part', { rowid: 1, message_id: 'm1', session_id: 's1', idx: 0, kind: 'text', text: 'hello' })
    for (const labeller of ['rules', 'claude-haiku-4-5']) {
      insert(db, 'label', {
        record_type: 'tool_call',
        record_id: 'c1',
        labeller,
        version: 1,
        name: 'purpose',
        value: 'run tests',
        labelled_at: 1,
      })
    }
    const dump = async (): Promise<string> => canonicalDump(warehouse.path, 'warehouse')

    try {
      // Act
      const before = await dump()
      db.exec(`UPDATE part SET rowid = 50;
        UPDATE harness SET checked_at = 9; UPDATE source_state SET imported_at = 9;
        UPDATE sync_run SET started_at = 9, ended_at = 10;
        UPDATE label SET labelled_at = 9 WHERE labeller = 'rules'`)
      const afterClock = await dump()
      db.exec("UPDATE label SET labelled_at = 9 WHERE labeller = 'claude-haiku-4-5'")
      const afterModel = await dump()

      // Assert
      expect({
        isClockIgnored: afterClock === before,
        isModelTimeKept: afterModel !== before,
        hasNoIndex: !before.includes('part_fts'),
      }).toStrictEqual({ isClockIgnored: true, isModelTimeKept: true, hasNoIndex: true })
    } finally {
      await warehouse.remove()
    }
  })
})
