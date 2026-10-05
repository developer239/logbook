import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IAdapterEnvironment, IHarnessAdapter, IRecognisedCommand } from '@log-book/adapter-api'
import { inventedAdapter, type IInventedUnit, type InventedCommands } from '@log-book/adapter-api/testing'
import { WarehouseStore } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importAdapter, locateAdapters, type LocatedAdapter } from '../sync/import-step.js'
import { deriveCommands } from './commands.js'

const COMMANDS_READ = 'SELECT session_id, message_id, at, command, source, has_file FROM session_command ORDER BY at'
const RELEASE: IRecognisedCommand = { command: 'release', source: 'template', hasFile: true }
const MODEL: IRecognisedCommand = { command: 'model', source: 'typed', hasFile: false }

const recognising = (prompts: Readonly<Record<string, IRecognisedCommand>>): InventedCommands => ({
  kind: 'recognises',
  prompts,
})

const unitWith = (
  locator: string,
  projectDir: string,
  prompts: readonly ['user' | 'harness', string, number][]
): IInventedUnit => ({
  locator,
  sessions: [
    {
      projectDir,
      messages: prompts.map(([actor, text, at]) => ({ actor, text, at })),
    },
  ],
})

describe('the command pass', () => {
  let directory = ''
  let warehouse: ITestWarehouse | null = null
  let store: WarehouseStore | null = null
  let env: IAdapterEnvironment = { variables: {}, homeDir: '', cwd: '', platform: 'linux' }

  const opened = (): { db: ITestWarehouse['db']; store: WarehouseStore } => {
    if (warehouse === null || store === null) {
      throw new Error('The warehouse is not open.')
    }
    return { db: warehouse.db, store }
  }

  // Locates and imports every adapter, as a sync does before its command pass.
  const imported = async (adapters: readonly IHarnessAdapter[]): Promise<LocatedAdapter[]> => {
    const located = await locateAdapters(adapters, env)
    await located.reduce(async (previous, adapter) => {
      await previous
      await importAdapter(adapter, {
        store: opened().store,
        signal: new AbortController().signal,
        now: () => 5_000,
        onProgress: () => undefined,
        log: () => undefined,
      })
    }, Promise.resolve())
    return located
  }

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-commands-')))
    env = { variables: {}, homeDir: directory, cwd: directory, platform: 'linux' }
    warehouse = await createTestWarehouse()
    store = await WarehouseStore.open(warehouse.path)
  })

  afterEach(async () => {
    store?.close()
    store = null
    await warehouse?.remove()
    warehouse = null
    await rm(directory, { recursive: true, force: true })
  })

  it('writes one row per recognised prompt, a harness message included, as the recogniser answered', async () => {
    // Arrange
    const located = await imported([
      inventedAdapter({
        listing: {
          kind: 'units',
          units: [
            unitWith('unit-1', '/work/shop', [
              ['user', 'release the shop', 1_000],
              ['user', 'fix the failing build', 2_000],
              ['harness', '/model', 3_000],
            ]),
          ],
        },
        commands: recognising({ 'release the shop': RELEASE, '/model': MODEL }),
      }),
    ])

    // Act
    const problems = await deriveCommands(opened().store, located, env)

    // Assert
    expect({ problems, rows: opened().store.all(COMMANDS_READ) }).toStrictEqual({
      problems: [],
      rows: [
        {
          session_id: 'test-harness:unit-1',
          message_id: 'test-harness:unit-1/m0',
          at: 1_000,
          command: 'release',
          source: 'template',
          has_file: 1,
        },
        {
          session_id: 'test-harness:unit-1',
          message_id: 'test-harness:unit-1/m2',
          at: 3_000,
          command: 'model',
          source: 'typed',
          has_file: 0,
        },
      ],
    })
  })

  it('gives an adapter whose data was not found this sync its rows, with a null location and each project once', async () => {
    // Arrange
    const units: IInventedUnit[] = [
      unitWith('unit-1', '/work/shop', [['user', 'release the shop', 1_000]]),
      unitWith('unit-2', '/work/shop', [['user', 'release the shop', 2_000]]),
      unitWith('unit-3', '/work/billing', [['user', 'release the shop', 3_000]]),
    ]
    await imported([inventedAdapter({ listing: { kind: 'units', units } })])
    const notFound = inventedAdapter({
      locate: { kind: 'not-found', lookedAt: null },
      commands: recognising({ 'release the shop': RELEASE }),
    })
    const located = await imported([notFound])

    // Act
    await deriveCommands(opened().store, located, env)

    // Assert
    const call = notFound.calls.find((candidate) => candidate.method === 'prepareCommands')
    expect({
      location: call?.args[0],
      projectDirs: call?.args[2],
      rows: opened()
        .store.all<{ session_id: string }>(COMMANDS_READ)
        .map((row) => row.session_id),
    }).toStrictEqual({
      location: null,
      projectDirs: ['/work/billing', '/work/shop'],
      rows: ['test-harness:unit-1', 'test-harness:unit-2', 'test-harness:unit-3'],
    })
  })

  it("leaves an adapter whose prepareCommands throws without rows, writes the other adapter's, and returns a problem", async () => {
    // Arrange
    const throwing = inventedAdapter({ commands: { kind: 'throws', message: 'the command files are unreadable' } })
    await imported([throwing])
    insert(opened().db, 'session', {
      id: 'other-harness:s1',
      harness: 'other-harness',
      source_id: 's1',
      origin: 'interactive',
      is_scripted: 0,
    })
    insert(opened().db, 'message', {
      id: 'other-harness:s1/m1',
      session_id: 'other-harness:s1',
      seq: 0,
      actor: 'user',
      source_role: 'user',
      created_at: 7_000,
    })
    insert(opened().db, 'part', {
      message_id: 'other-harness:s1/m1',
      session_id: 'other-harness:s1',
      idx: 0,
      kind: 'text',
      text: 'release the shop',
    })
    const other = inventedAdapter({ commands: recognising({ 'release the shop': RELEASE }) })
    const located = await locateAdapters(
      [throwing, { ...other, descriptor: { ...other.descriptor, id: 'other-harness', filterAlias: 'other' } }],
      env
    )

    // Act
    const problems = await deriveCommands(opened().store, located, env)

    // Assert
    expect({
      problems,
      rows: opened()
        .store.all<{ session_id: string }>(COMMANDS_READ)
        .map((row) => row.session_id),
    }).toStrictEqual({
      problems: [{ adapter: 'test-harness', reason: 'the command files are unreadable' }],
      rows: ['other-harness:s1'],
    })
  })

  it('leaves only its own rows on a second pass', async () => {
    // Arrange
    const adapter = inventedAdapter({
      listing: {
        kind: 'units',
        units: [
          unitWith('unit-1', '/work/shop', [
            ['user', 'release the shop', 1_000],
            ['user', '/model', 2_000],
          ]),
        ],
      },
      commands: recognising({ 'release the shop': RELEASE, '/model': MODEL }),
    })
    const located = await imported([adapter])
    await deriveCommands(opened().store, located, env)
    const narrower = inventedAdapter({ commands: recognising({ '/model': MODEL }) })

    // Act
    await deriveCommands(opened().store, await locateAdapters([narrower], env), env)

    // Assert
    expect(
      opened()
        .store.all<{ command: string }>(COMMANDS_READ)
        .map((row) => row.command)
    ).toStrictEqual(['model'])
  })
})
