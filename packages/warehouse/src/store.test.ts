import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openSqlite, runSubprocess } from '@log-book/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IHarnessDescriptorRecord, IImportedSession, ISourceStateRecord } from './records.js'
import { WarehouseStore } from './store.js'
import { insert } from './testing/index.js'

const CHILD_TIMEOUT_MS = 10_000

// The permission bits, the low nine bits of the mode.
const modeOf = (path: string): number => statSync(path).mode % 0o1000

// Builds a warehouse file at `version` with nothing in it but the version.
const writeVersionedFile = async (path: string, version: number): Promise<void> => {
  const db = await openSqlite(path, { isReadOnly: false })
  db.exec(`PRAGMA user_version = ${String(version)}`)
  db.close()
}

// Lets a child process import the TypeScript sources: Node strips the types, and this maps an import of `./x.js` to
// `./x.ts` when no `./x.js` exists.
const RESOLVE_TYPESCRIPT_HOOK = `export const resolve = async (specifier, context, nextResolve) => {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context)
    }
    throw error
  }
}
`

// Signals ready, waits for the go file, then opens the warehouse once.
const RACING_CHILD = `import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
const [storeUrl, warehousePath, readyFile, goFile] = process.argv.slice(2)
const { WarehouseStore } = await import(storeUrl)
writeFileSync(readyFile, '')
while (!existsSync(goFile)) {
  await delay(5)
}
const store = await WarehouseStore.open(warehousePath)
store.close()
`

describe('WarehouseStore', () => {
  let directory = ''
  let dataDirectory = ''

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-store-')))
    vi.stubEnv('XDG_DATA_HOME', join(directory, 'data'))
    vi.stubEnv('LOGBOOK_DB', undefined)
    dataDirectory = join(directory, 'data', 'log-book')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  describe('open', () => {
    it('creates a new warehouse with a 0700 directory and 0600 files', async () => {
      // Arrange
      const path = join(dataDirectory, 'warehouse.db')

      // Act
      const store = await WarehouseStore.open(path)
      const modes = [dataDirectory, path, `${path}-wal`, `${path}-shm`].map(modeOf)
      store.close()

      // Assert
      expect(modes).toStrictEqual([0o700, 0o600, 0o600, 0o600])
    })

    it('tightens a loosened directory and files inside the data directory', async () => {
      // Arrange
      const path = join(dataDirectory, 'warehouse.db')
      ;(await WarehouseStore.open(path)).close()
      chmodSync(dataDirectory, 0o755)
      chmodSync(path, 0o644)

      // Act
      const store = await WarehouseStore.open(path)
      const modes = [dataDirectory, path, `${path}-wal`, `${path}-shm`].map(modeOf)
      store.close()

      // Assert
      expect(modes).toStrictEqual([0o700, 0o600, 0o600, 0o600])
    })

    it('keeps the mode of an existing directory outside the data directory and tightens the files', async () => {
      // Arrange
      const userDirectory = join(directory, 'elsewhere')
      mkdirSync(userDirectory)
      chmodSync(userDirectory, 0o755)
      const path = join(userDirectory, 'warehouse.db')

      // Act
      const store = await WarehouseStore.open(path)
      const modes = [userDirectory, path, `${path}-wal`, `${path}-shm`].map(modeOf)
      store.close()

      // Assert
      expect(modes).toStrictEqual([0o755, 0o600, 0o600, 0o600])
    })

    it('sets the write-ahead log and its size limit', async () => {
      // Arrange
      const store = await WarehouseStore.open(join(dataDirectory, 'warehouse.db'))

      // Act
      const pragmas = [store.get('PRAGMA journal_mode'), store.get('PRAGMA journal_size_limit')]
      store.close()

      // Assert
      expect(pragmas).toStrictEqual([{ journal_mode: 'wal' }, { journal_size_limit: 67_108_864 }])
    })

    it('creates a missing warehouse at the newest version', async () => {
      // Arrange
      const path = join(dataDirectory, 'nested', 'warehouse.db')

      // Act
      const store = await WarehouseStore.open(path)
      const result = {
        previousVersion: store.previousVersion,
        version: store.version,
        userVersion: store.get('PRAGMA user_version'),
      }
      store.close()

      // Assert
      expect(result).toStrictEqual({ previousVersion: 0, version: 1, userVersion: { user_version: 1 } })
    })

    it('migrates an older warehouse and reports both versions', async () => {
      // Arrange
      mkdirSync(dataDirectory, { recursive: true })
      const path = join(dataDirectory, 'warehouse.db')
      await writeVersionedFile(path, 0)

      // Act
      const store = await WarehouseStore.open(path)
      const result = { previousVersion: store.previousVersion, version: store.version }
      store.close()

      // Assert
      expect(result).toStrictEqual({ previousVersion: 0, version: 1 })
    })

    it('opens a warehouse at the newest version', async () => {
      // Arrange
      const path = join(dataDirectory, 'warehouse.db')
      ;(await WarehouseStore.open(path)).close()

      // Act
      const store = await WarehouseStore.open(path)
      const result = { previousVersion: store.previousVersion, version: store.version }
      store.close()

      // Assert
      expect(result).toStrictEqual({ previousVersion: 1, version: 1 })
    })

    it('refuses a newer warehouse with both versions and leaves its bytes unchanged', async () => {
      // Arrange
      mkdirSync(dataDirectory, { recursive: true })
      const path = join(dataDirectory, 'warehouse.db')
      await writeVersionedFile(path, 2)
      const before = await readFile(path)

      // Act
      const opening = WarehouseStore.open(path)

      // Assert
      await expect(opening).rejects.toThrow(
        expect.objectContaining({ code: 'WAREHOUSE_SCHEMA_NEWER', warehouseVersion: 2, buildVersion: 1 })
      )
      expect((await readFile(path)).equals(before)).toBe(true)
    })

    it('applies a missing step once when two processes open the same old warehouse at once', async () => {
      // Arrange
      mkdirSync(dataDirectory, { recursive: true })
      const path = join(dataDirectory, 'warehouse.db')
      await writeVersionedFile(path, 0)
      const hook = join(directory, 'hook.mjs')
      const register = join(directory, 'register.mjs')
      const child = join(directory, 'child.mjs')
      const goFile = join(directory, 'go')
      await writeFile(hook, RESOLVE_TYPESCRIPT_HOOK)
      await writeFile(
        register,
        `import { register } from 'node:module'\nregister(${JSON.stringify(pathToFileURL(hook).href)})\n`
      )
      await writeFile(child, RACING_CHILD)
      const storeUrl = new URL('./store.ts', import.meta.url).href
      const readyFiles = [join(directory, 'ready-1'), join(directory, 'ready-2')]
      const children = readyFiles.map((readyFile) =>
        runSubprocess({
          command: process.execPath,
          args: ['--import', register, child, storeUrl, path, readyFile, goFile],
          timeoutMs: CHILD_TIMEOUT_MS,
          label: 'node',
        })
      )
      await vi.waitFor(() => expect(readyFiles.map((file) => existsSync(file))).toStrictEqual([true, true]), {
        timeout: CHILD_TIMEOUT_MS,
      })

      // Act
      await writeFile(goFile, '')
      const results = await Promise.all(children)

      // Assert
      expect(results.map(({ exitCode, stderr }) => ({ exitCode, stderr }))).toStrictEqual([
        { exitCode: 0, stderr: '' },
        { exitCode: 0, stderr: '' },
      ])
      const db = await openSqlite(path, { isReadOnly: true })
      expect(db.prepare('PRAGMA user_version').get()).toStrictEqual(
        Object.assign(Object.create(null) as object, { user_version: 1 })
      )
      db.close()
    })
  })

  describe('openReadOnly', () => {
    it('refuses a missing warehouse and creates nothing', async () => {
      // Arrange
      const missingDirectory = join(directory, 'missing')
      const path = join(missingDirectory, 'warehouse.db')

      // Act
      const opening = WarehouseStore.openReadOnly(path)

      // Assert
      await expect(opening).rejects.toThrow(
        expect.objectContaining({ code: 'WAREHOUSE_NOT_FOUND', message: `No warehouse at ${path}.` })
      )
      expect(existsSync(missingDirectory)).toBe(false)
    })

    it.each([
      { state: 'older', version: 0 },
      { state: 'newer', version: 2 },
    ])('refuses an $state warehouse with both versions', async ({ version }) => {
      // Arrange
      mkdirSync(dataDirectory, { recursive: true })
      const path = join(dataDirectory, 'warehouse.db')
      await writeVersionedFile(path, version)

      // Act
      const opening = WarehouseStore.openReadOnly(path)

      // Assert
      await expect(opening).rejects.toThrow(
        expect.objectContaining({ code: 'WAREHOUSE_SCHEMA_MISMATCH', warehouseVersion: version, buildVersion: 1 })
      )
    })

    it('opens a warehouse at the newest version and reads it', async () => {
      // Arrange
      const path = join(dataDirectory, 'warehouse.db')
      ;(await WarehouseStore.open(path)).close()

      // Act
      const reader = await WarehouseStore.openReadOnly(path)
      const result = { version: reader.get('PRAGMA user_version'), sessions: reader.all('SELECT id FROM session') }
      reader.close()

      // Assert
      expect(result).toStrictEqual({ version: { user_version: 1 }, sessions: [] })
    })
  })
})

const HARNESS = 'test-harness'
const LOCATOR = 'units/unit-1.jsonl'

// One invented session with a message, a part, a tool call and an event, all named after the session.
const importedSession = (sessionId: string, text: string, createdAt: number | string = 1_000): IImportedSession => ({
  session: {
    id: sessionId,
    harness: HARNESS,
    sourceId: sessionId.split(':')[1] ?? sessionId,
    origin: 'interactive',
    isScripted: false,
    projectDir: '/work/example',
    title: 'Example session',
    agent: null,
    spawnedBySessionId: null,
    spawnedByToolCallId: null,
    startedAt: 1_000,
    endedAt: 2_000,
  },
  messages: [
    {
      id: `${sessionId}/m1`,
      sessionId,
      seq: 0,
      actor: 'user',
      sourceRole: 'user',
      // A string here is refused by STRICT, which the failed-write test relies on.
      createdAt: createdAt as number,
      completedAt: null,
      requestedAt: null,
      model: null,
      agent: null,
      gitBranch: null,
      tokensInput: null,
      tokensOutput: null,
      tokensReasoning: null,
      tokensCacheRead: null,
      tokensCacheWrite: null,
      reportedCost: null,
    },
  ],
  parts: [{ messageId: `${sessionId}/m1`, sessionId, idx: 0, kind: 'text', text, toolCallId: null }],
  toolCalls: [
    {
      id: `${sessionId}/c1`,
      sessionId,
      messageId: `${sessionId}/m1`,
      name: 'Read',
      bareName: 'Read',
      server: null,
      family: 'read',
      inputJson: '{}',
      status: 'completed',
      childSessionId: null,
      startedAt: 1_100,
      endedAt: 1_200,
    },
  ],
  events: [{ id: `${sessionId}/e1`, sessionId, kind: 'idle', at: 1_500, dataJson: '{}' }],
})

const sourceState = (fingerprint: string, importedAt = 5_000): ISourceStateRecord => ({
  harness: HARNESS,
  locator: LOCATOR,
  fingerprint,
  parserVersion: 3,
  importedAt,
})

const IMPORTED_TABLES = ['session', 'message', 'part', 'tool_call', 'event', 'source_state']

const counts = (opened: WarehouseStore): Record<string, number> =>
  Object.fromEntries(
    IMPORTED_TABLES.map((table) => [
      table,
      opened.get<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)?.count ?? -1,
    ])
  )

const search = (opened: WarehouseStore, phrase: string): string[] =>
  opened
    .all<{ session_id: string }>(
      'SELECT part.session_id FROM part_fts JOIN part ON part.rowid = part_fts.rowid WHERE part_fts MATCH ?',
      `"${phrase}"`
    )
    .map((row) => row.session_id)

describe('WarehouseStore unit writes', () => {
  let directory = ''
  let store: WarehouseStore | null = null

  const openStore = async (): Promise<WarehouseStore> => {
    store = await WarehouseStore.open(join(directory, 'warehouse.db'))
    return store
  }

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-unit-')))
    vi.stubEnv('XDG_DATA_HOME', join(directory, 'data'))
  })

  afterEach(async () => {
    store?.close()
    store = null
    await rm(directory, { recursive: true, force: true })
  })

  it('writes a new unit to every imported table and finds its text', async () => {
    // Arrange
    const opened = await openStore()

    // Act
    opened.writeImportedUnit([importedSession('test-harness:s1', 'the build is green')], sourceState('f1'))

    // Assert
    expect({ counts: counts(opened), found: search(opened, 'build is green') }).toStrictEqual({
      counts: { session: 1, message: 1, part: 1, tool_call: 1, event: 1, source_state: 1 },
      found: ['test-harness:s1'],
    })
  })

  it('replaces a changed unit, and text it no longer holds is no longer found', async () => {
    // Arrange
    const opened = await openStore()
    opened.writeImportedUnit([importedSession('test-harness:s1', 'the build is green')], sourceState('f1'))

    // Act
    opened.writeImportedUnit([importedSession('test-harness:s1', 'the build is red')], sourceState('f2'))

    // Assert
    expect({
      counts: counts(opened),
      old: search(opened, 'build is green'),
      new: search(opened, 'build is red'),
      state: opened.readSourceState(HARNESS, LOCATOR),
    }).toStrictEqual({
      counts: { session: 1, message: 1, part: 1, tool_call: 1, event: 1, source_state: 1 },
      old: [],
      new: ['test-harness:s1'],
      state: { fingerprint: 'f2', parserVersion: 3 },
    })
  })

  it('keeps the labels on a re-imported session', async () => {
    // Arrange
    const opened = await openStore()
    opened.writeImportedUnit([importedSession('test-harness:s1', 'first text')], sourceState('f1'))
    const db = await openSqlite(join(directory, 'warehouse.db'), { isReadOnly: false })
    insert(db, 'label', {
      record_type: 'tool_call',
      record_id: 'test-harness:s1/c1',
      labeller: 'model-a',
      version: 1,
      name: 'purpose',
      value: 'read a file',
      labelled_at: 3_000,
    })
    db.close()

    // Act
    opened.writeImportedUnit([importedSession('test-harness:s1', 'second text')], sourceState('f2'))

    // Assert
    expect(opened.all('SELECT record_id, value FROM label')).toStrictEqual([
      { record_id: 'test-harness:s1/c1', value: 'read a file' },
    ])
  })

  it('leaves every table as it was when the write fails part-way', async () => {
    // Arrange
    const opened = await openStore()
    opened.writeImportedUnit([importedSession('test-harness:s1', 'kept text')], sourceState('f1', 5_000))
    const before = { counts: counts(opened), rows: opened.all('SELECT * FROM source_state') }

    // Act
    const writing = (): void =>
      opened.writeImportedUnit(
        [importedSession('test-harness:s1', 'new text'), importedSession('test-harness:s2', 'broken', 'soon')],
        sourceState('f2', 6_000)
      )

    // Assert
    expect(writing).toThrow('cannot store TEXT value in INTEGER column message.created_at')
    expect({ counts: counts(opened), rows: opened.all('SELECT * FROM source_state') }).toStrictEqual(before)
    expect(search(opened, 'kept text')).toStrictEqual(['test-harness:s1'])
  })

  it('leaves out a forgotten session and writes the rest of the unit', async () => {
    // Arrange
    const opened = await openStore()
    const db = await openSqlite(join(directory, 'warehouse.db'), { isReadOnly: false })
    insert(db, 'forgotten', { session_id: 'test-harness:s2', forgotten_at: 4_000 })
    db.close()

    // Act
    opened.writeImportedUnit(
      [importedSession('test-harness:s1', 'kept'), importedSession('test-harness:s2', 'forgotten')],
      sourceState('f1')
    )

    // Assert
    expect({
      sessions: opened.all('SELECT id FROM session'),
      state: opened.readSourceState(HARNESS, LOCATOR),
    }).toStrictEqual({ sessions: [{ id: 'test-harness:s1' }], state: { fingerprint: 'f1', parserVersion: 3 } })
  })

  it('keeps the rows of a session a re-imported unit no longer produces', async () => {
    // Arrange
    const opened = await openStore()
    opened.writeImportedUnit(
      [importedSession('test-harness:s1', 'first'), importedSession('test-harness:s2', 'second')],
      sourceState('f1')
    )

    // Act
    opened.writeImportedUnit([importedSession('test-harness:s1', 'first again')], sourceState('f2'))

    // Assert
    expect({
      sessions: opened.all('SELECT id FROM session ORDER BY id'),
      found: search(opened, 'second'),
    }).toStrictEqual({ sessions: [{ id: 'test-harness:s1' }, { id: 'test-harness:s2' }], found: ['test-harness:s2'] })
  })

  it('stores the import time the caller passed', async () => {
    // Arrange
    const opened = await openStore()

    // Act
    opened.writeImportedUnit([importedSession('test-harness:s1', 'text')], sourceState('f1', 1_791_100_800_000))

    // Assert
    expect(
      opened.all('SELECT harness, locator, fingerprint, parser_version, imported_at FROM source_state')
    ).toStrictEqual([
      { harness: HARNESS, locator: LOCATOR, fingerprint: 'f1', parser_version: 3, imported_at: 1_791_100_800_000 },
    ])
  })

  it('reads no state for a unit never imported', async () => {
    // Arrange
    const opened = await openStore()

    // Act
    const state = opened.readSourceState(HARNESS, 'units/never.jsonl')

    // Assert
    expect(state).toBeNull()
  })
})

const descriptor = (id: string, fields: Partial<IHarnessDescriptorRecord> = {}): IHarnessDescriptorRecord => ({
  id,
  name: `Harness ${id}`,
  defaultAgent: 'build',
  filterAlias: id,
  isFound: true,
  checkedAt: 1_000,
  location: `~/.${id}`,
  locationVariables: [],
  ...fields,
})

const HARNESS_COLUMNS_READ =
  'SELECT id, name, default_agent, filter_alias, is_found, checked_at, location, location_variables, version_seen, notice, problem FROM harness ORDER BY id'

describe('WarehouseStore bookkeeping', () => {
  let directory = ''
  let store: WarehouseStore | null = null

  const openStore = async (): Promise<WarehouseStore> => {
    store = await WarehouseStore.open(join(directory, 'warehouse.db'))
    return store
  }

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-bookkeeping-')))
    vi.stubEnv('XDG_DATA_HOME', join(directory, 'data'))
  })

  afterEach(async () => {
    store?.close()
    store = null
    await rm(directory, { recursive: true, force: true })
  })

  it('inserts each adapter row with no version, notice or problem', async () => {
    // Arrange
    const opened = await openStore()

    // Act
    opened.writeHarnessDescriptors([descriptor('alpha'), descriptor('beta', { isFound: false, location: null })])

    // Assert
    expect(opened.all(HARNESS_COLUMNS_READ)).toStrictEqual([
      {
        id: 'alpha',
        name: 'Harness alpha',
        default_agent: 'build',
        filter_alias: 'alpha',
        is_found: 1,
        checked_at: 1_000,
        location: '~/.alpha',
        location_variables: '[]',
        version_seen: null,
        notice: null,
        problem: null,
      },
      {
        id: 'beta',
        name: 'Harness beta',
        default_agent: 'build',
        filter_alias: 'beta',
        is_found: 0,
        checked_at: 1_000,
        location: null,
        location_variables: '[]',
        version_seen: null,
        notice: null,
        problem: null,
      },
    ])
  })

  it('changes the descriptor fields on a later upsert and keeps the step-end columns', async () => {
    // Arrange
    const opened = await openStore()
    opened.writeHarnessDescriptors([descriptor('alpha')])
    opened.writeHarnessStepEnd('alpha', { versionSeen: '2.1.0', notice: 'A notice.', problem: 'A problem.' })

    // Act
    opened.writeHarnessDescriptors([
      descriptor('alpha', {
        name: 'Alpha',
        defaultAgent: 'plan',
        filterAlias: 'a',
        isFound: false,
        checkedAt: 2_000,
        location: '~/elsewhere',
        locationVariables: ['ALPHA_HOME', 'ALPHA_DATA'],
      }),
    ])

    // Assert
    expect(opened.all(HARNESS_COLUMNS_READ)).toStrictEqual([
      {
        id: 'alpha',
        name: 'Alpha',
        default_agent: 'plan',
        filter_alias: 'a',
        is_found: 0,
        checked_at: 2_000,
        location: '~/elsewhere',
        location_variables: '["ALPHA_HOME","ALPHA_DATA"]',
        version_seen: '2.1.0',
        notice: 'A notice.',
        problem: 'A problem.',
      },
    ])
  })

  it('sets the step-end columns and sets them back to null', async () => {
    // Arrange
    const opened = await openStore()
    opened.writeHarnessDescriptors([descriptor('alpha')])
    const read = (): unknown => opened.get('SELECT version_seen, notice, problem FROM harness WHERE id = ?', 'alpha')

    // Act
    opened.writeHarnessStepEnd('alpha', { versionSeen: '2.1.0', notice: 'Newer than tested.', problem: null })
    const set = read()
    opened.writeHarnessStepEnd('alpha', { versionSeen: null, notice: null, problem: null })

    // Assert
    expect({ set, cleared: read() }).toStrictEqual({
      set: { version_seen: '2.1.0', notice: 'Newer than tested.', problem: null },
      cleared: { version_seen: null, notice: null, problem: null },
    })
  })

  it('writes a notice of two sentences and a problem with no version seen', async () => {
    // Arrange
    const opened = await openStore()
    opened.writeHarnessDescriptors([descriptor('alpha')])
    const step = {
      versionSeen: null,
      notice: 'The harness is newer than tested. Its data format is newer than tested.',
      problem: 'The listing failed.',
    }

    // Act
    opened.writeHarnessStepEnd('alpha', step)

    // Assert
    expect(opened.get('SELECT version_seen, notice, problem FROM harness WHERE id = ?', 'alpha')).toStrictEqual({
      version_seen: null,
      notice: step.notice,
      problem: step.problem,
    })
  })

  it('keeps the row of an adapter missing from a later upsert', async () => {
    // Arrange
    const opened = await openStore()
    opened.writeHarnessDescriptors([descriptor('alpha'), descriptor('beta')])

    // Act
    opened.writeHarnessDescriptors([descriptor('alpha', { checkedAt: 2_000 })])

    // Assert
    expect(opened.all('SELECT id, name, checked_at FROM harness ORDER BY id')).toStrictEqual([
      { id: 'alpha', name: 'Harness alpha', checked_at: 2_000 },
      { id: 'beta', name: 'Harness beta', checked_at: 1_000 },
    ])
  })

  it('reads location_variables back as the JSON array written', async () => {
    // Arrange
    const opened = await openStore()

    // Act
    opened.writeHarnessDescriptors([
      descriptor('alpha', { locationVariables: [] }),
      descriptor('beta', { locationVariables: ['BETA_DB'] }),
    ])

    // Assert
    expect(
      opened
        .all<{ location_variables: string }>('SELECT location_variables FROM harness ORDER BY id')
        .map((row) => JSON.parse(row.location_variables) as unknown)
    ).toStrictEqual([[], ['BETA_DB']])
  })

  it('fails an upsert where two adapters share a filter alias and writes neither row', async () => {
    // Arrange
    const opened = await openStore()

    // Act
    const writing = (): void =>
      opened.writeHarnessDescriptors([
        descriptor('alpha', { filterAlias: 'same' }),
        descriptor('beta', { filterAlias: 'same' }),
      ])

    // Assert
    expect(writing).toThrow('UNIQUE constraint failed: harness.filter_alias')
    expect(opened.all('SELECT id FROM harness')).toStrictEqual([])
  })

  it.each([
    { outcome: 'ok', error: null },
    { outcome: 'partial', error: 'One harness could not be read.' },
    { outcome: 'failed', error: 'The warehouse is full.' },
    { outcome: 'stopped', error: null },
  ] as const)('starts and ends a sync record as $outcome', async ({ outcome, error }) => {
    // Arrange
    const opened = await openStore()

    // Act
    const id = opened.startSyncRecord(1_000)
    opened.endSyncRecord(id, { endedAt: 2_000, outcome, error })

    // Assert
    expect(opened.all('SELECT id, started_at, ended_at, outcome, error FROM sync_run')).toStrictEqual([
      { id, started_at: 1_000, ended_at: 2_000, outcome, error },
    ])
  })

  it('keeps the newest 100 sync records', async () => {
    // Arrange
    const opened = await openStore()
    const ids = Array.from({ length: 100 }, (_, index) => opened.startSyncRecord(1_000 + index))

    // Act
    const newest = opened.startSyncRecord(5_000)

    // Assert
    expect(opened.all<{ id: number }>('SELECT id FROM sync_run ORDER BY id').map((row) => row.id)).toStrictEqual([
      ...ids.slice(1),
      newest,
    ])
  })
})
