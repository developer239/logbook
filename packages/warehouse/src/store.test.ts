import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LogBookError, openSqlite, runSubprocess } from '@log-book/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WAREHOUSE_ERROR_CODES } from './errors.js'
import type {
  IHarnessDescriptorRecord,
  IImportedSession,
  ILabelRecord,
  ILabelRunStartRecord,
  ILinkRecord,
  ISessionCommandRecord,
  ISourceStateRecord,
  ITurnRecord,
} from './records.js'
import { RULES_LABELLER, WarehouseStore } from './store.js'
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

const sessionRow = (id: string, isScripted: number): Record<string, string | number | null> => ({
  id,
  harness: HARNESS,
  source_id: id,
  origin: 'interactive',
  is_scripted: isScripted,
})

const subagentLink = (parent: string, child: string): ILinkRecord => ({
  parentSessionId: parent,
  parentToolCallId: `${parent}/c1`,
  childSessionId: child,
  kind: 'subagent',
  confidence: 'exact',
  evidence: 'tool call id',
})

const turnRecord = (messageId: string, startedAt: number | string = 1_000): ITurnRecord => ({
  sessionId: 'test-harness:s1',
  messageId,
  seq: 0,
  isPrompt: true,
  requests: 1,
  toolCalls: 0,
  // A string here is refused by STRICT, which the failed-replace test relies on.
  startedAt: startedAt as number,
  endedAt: 2_000,
  modelMs: 500,
  toolMs: 0,
  idleMs: 0,
  humanWaitMs: 0,
  parentTurnId: null,
  parentToolCallId: null,
})

const labelRecord = (fields: Partial<ILabelRecord>): ILabelRecord => ({
  recordType: 'tool_call',
  recordId: 'test-harness:s1/c1',
  labeller: 'model-a',
  version: 1,
  name: 'purpose',
  value: 'read a file',
  labelledAt: 1_000,
  ...fields,
})

const commandRecord = (name: string): ISessionCommandRecord => ({
  sessionId: 'test-harness:s1',
  messageId: 'test-harness:s1/m1',
  at: 1_000,
  command: name,
  source: 'typed',
  hasFile: name !== 'model',
})

const LABELS_READ = 'SELECT record_type, record_id, labeller, version, name, value FROM label ORDER BY 1, 2, 3, 4, 5'

describe('WarehouseStore derived tables and labels', () => {
  let directory = ''
  let store: WarehouseStore | null = null

  const openStore = async (): Promise<WarehouseStore> => {
    store = await WarehouseStore.open(join(directory, 'warehouse.db'))
    return store
  }

  const insertRows = async (table: string, rows: Record<string, string | number | null>[]): Promise<void> => {
    const db = await openSqlite(join(directory, 'warehouse.db'), { isReadOnly: false })
    for (const row of rows) {
      insert(db, table, row)
    }
    db.close()
  }

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-derived-')))
    vi.stubEnv('XDG_DATA_HOME', join(directory, 'data'))
  })

  afterEach(async () => {
    store?.close()
    store = null
    await rm(directory, { recursive: true, force: true })
  })

  it('sets each session origin from is_scripted and incoming subagent links', async () => {
    // Arrange
    const opened = await openStore()
    await insertRows('session', [
      sessionRow('parent', 0),
      sessionRow('plain', 0),
      sessionRow('script', 1),
      sessionRow('child', 0),
      sessionRow('scripted-child', 1),
    ])

    // Act
    opened.replaceLinks([subagentLink('parent', 'child'), subagentLink('parent', 'scripted-child')])

    // Assert
    expect(opened.all('SELECT id, origin FROM session ORDER BY id')).toStrictEqual([
      { id: 'child', origin: 'subagent' },
      { id: 'parent', origin: 'interactive' },
      { id: 'plain', origin: 'interactive' },
      { id: 'script', origin: 'scripted' },
      { id: 'scripted-child', origin: 'subagent' },
    ])
  })

  it('returns a session to interactive or scripted when the next write leaves out its link', async () => {
    // Arrange
    const opened = await openStore()
    await insertRows('session', [sessionRow('parent', 0), sessionRow('child', 0), sessionRow('scripted-child', 1)])
    opened.replaceLinks([subagentLink('parent', 'child'), subagentLink('parent', 'scripted-child')])

    // Act
    opened.replaceLinks([])

    // Assert
    expect(opened.all('SELECT id, origin FROM session ORDER BY id')).toStrictEqual([
      { id: 'child', origin: 'interactive' },
      { id: 'parent', origin: 'interactive' },
      { id: 'scripted-child', origin: 'scripted' },
    ])
  })

  it('leaves only the second write of links, commands and turns', async () => {
    // Arrange
    const opened = await openStore()
    opened.replaceLinks([subagentLink('a', 'b')])
    opened.replaceSessionCommands([commandRecord('review')])
    opened.replaceTurns([turnRecord('test-harness:s1/m1')])

    // Act
    opened.replaceLinks([subagentLink('c', 'd')])
    opened.replaceSessionCommands([commandRecord('model')])
    opened.replaceTurns([turnRecord('test-harness:s1/m2')])

    // Assert
    expect({
      links: opened.all('SELECT parent_session_id, child_session_id FROM link'),
      commands: opened.all('SELECT command, has_file FROM session_command'),
      turns: opened.all('SELECT message_id, is_prompt FROM turn'),
    }).toStrictEqual({
      links: [{ parent_session_id: 'c', child_session_id: 'd' }],
      commands: [{ command: 'model', has_file: 0 }],
      turns: [{ message_id: 'test-harness:s1/m2', is_prompt: 1 }],
    })
  })

  it('replaces the rule labels of one record type and keeps the others and every model label', async () => {
    // Arrange
    const opened = await openStore()
    opened.writeLabels([
      labelRecord({ labeller: RULES_LABELLER, value: 'old rule' }),
      labelRecord({
        recordType: 'session',
        recordId: 'test-harness:s1',
        labeller: RULES_LABELLER,
        name: 'initiator',
        value: 'human',
      }),
      labelRecord({ labeller: 'model-a', value: 'model answer' }),
    ])

    // Act
    opened.replaceRuleLabels('tool_call', [
      labelRecord({ recordId: 'test-harness:s1/c2', labeller: RULES_LABELLER, value: 'new rule' }),
    ])

    // Assert
    expect(opened.all(LABELS_READ)).toStrictEqual([
      {
        record_type: 'session',
        record_id: 'test-harness:s1',
        labeller: 'rules',
        version: 1,
        name: 'initiator',
        value: 'human',
      },
      {
        record_type: 'tool_call',
        record_id: 'test-harness:s1/c1',
        labeller: 'model-a',
        version: 1,
        name: 'purpose',
        value: 'model answer',
      },
      {
        record_type: 'tool_call',
        record_id: 'test-harness:s1/c2',
        labeller: 'rules',
        version: 1,
        name: 'purpose',
        value: 'new rule',
      },
    ])
  })

  it('replaces the value and time of a model label with the same key', async () => {
    // Arrange
    const opened = await openStore()
    opened.writeLabels([labelRecord({ value: 'first', labelledAt: 1_000 })])

    // Act
    opened.writeLabels([labelRecord({ value: 'second', labelledAt: 2_000 })])

    // Assert
    expect(opened.all('SELECT value, labelled_at FROM label')).toStrictEqual([{ value: 'second', labelled_at: 2_000 }])
  })

  it("drops one labeller's fields, returns the count, and keeps another model's and the rules' labels", async () => {
    // Arrange
    const opened = await openStore()
    opened.writeLabels([
      labelRecord({ name: 'purpose' }),
      labelRecord({ name: 'failure' }),
      labelRecord({ name: 'kept' }),
      labelRecord({ labeller: 'model-b', name: 'purpose' }),
      labelRecord({ labeller: RULES_LABELLER, name: 'purpose' }),
    ])

    // Act
    const count = opened.dropLabels('tool_call', 'model-a', ['purpose', 'failure'])

    // Assert
    expect({ count, rows: opened.all('SELECT labeller, name FROM label ORDER BY labeller, name') }).toStrictEqual({
      count: 2,
      rows: [
        { labeller: 'model-a', name: 'kept' },
        { labeller: 'model-b', name: 'purpose' },
        { labeller: 'rules', name: 'purpose' },
      ],
    })
  })

  it('lists labelled records per labeller and version', async () => {
    // Arrange
    const opened = await openStore()
    opened.writeLabels([
      labelRecord({ recordId: 'call-1', version: 1 }),
      labelRecord({ recordId: 'call-2', version: 1 }),
      labelRecord({ recordId: 'call-2', version: 2 }),
      labelRecord({ recordId: 'call-3', version: 2, labeller: 'model-b' }),
    ])

    // Act
    const lists = {
      versionOne: opened.labelledRecordIds('tool_call', 'purpose', 'model-a', 1),
      versionTwo: opened.labelledRecordIds('tool_call', 'purpose', 'model-a', 2),
    }

    // Assert
    expect(lists).toStrictEqual({ versionOne: new Set(['call-1', 'call-2']), versionTwo: new Set(['call-2']) })
  })

  it('keeps the previous rows when a replace fails part-way', async () => {
    // Arrange
    const opened = await openStore()
    opened.replaceTurns([turnRecord('test-harness:s1/m1')])

    // Act
    const replacing = (): void =>
      opened.replaceTurns([turnRecord('test-harness:s1/m2'), turnRecord('test-harness:s1/m3', 'soon')])

    // Assert
    expect(replacing).toThrow('cannot store TEXT value in INTEGER column turn.started_at')
    expect(opened.all('SELECT message_id FROM turn')).toStrictEqual([{ message_id: 'test-harness:s1/m1' }])
  })
})

const ALL_TASKS = ['shell', 'tool-failure', 'session', 'outcome', 'prompt', 'reply']

const runStart = (tasks: readonly string[]): ILabelRunStartRecord => ({
  pid: 4242,
  startedAt: 1_000,
  model: 'model-a',
  tasks: tasks.map((task) => ({ task, version: 2, planned: 10 })),
})

const RUN_TASKS_READ = 'SELECT run_id, task, version, planned, done FROM label_run_task ORDER BY task'

describe('WarehouseStore labelling run record', () => {
  let directory = ''
  let store: WarehouseStore | null = null

  const openStore = async (): Promise<WarehouseStore> => {
    store = await WarehouseStore.open(join(directory, 'warehouse.db'))
    return store
  }

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-label-run-')))
    vi.stubEnv('XDG_DATA_HOME', join(directory, 'data'))
  })

  afterEach(async () => {
    store?.close()
    store = null
    await rm(directory, { recursive: true, force: true })
  })

  it('starts a run with the six tasks, each with nothing done', async () => {
    // Arrange
    const opened = await openStore()

    // Act
    const id = opened.startLabelRun(runStart(ALL_TASKS))

    // Assert
    expect({
      runs: opened.all('SELECT id, pid, started_at, ended_at, outcome, error, model FROM label_run'),
      tasks: opened.all(RUN_TASKS_READ),
    }).toStrictEqual({
      runs: [{ id, pid: 4242, started_at: 1_000, ended_at: null, outcome: null, error: null, model: 'model-a' }],
      tasks: ALL_TASKS.toSorted().map((task) => ({ run_id: id, task, version: 2, planned: 10, done: 0 })),
    })
  })

  it("changes only a started task's row, and refuses a task the run did not start with", async () => {
    // Arrange
    const opened = await openStore()
    const id = opened.startLabelRun(runStart(['prompt']))

    // Act
    opened.replanLabelRunTask(id, 'prompt', 7)
    opened.writeLabelRunBatch(id, 'prompt', [labelRecord({ recordType: 'message', name: 'act' })], 1)
    const refusals = [
      (): void => {
        opened.replanLabelRunTask(id, 'reply', 3)
      },
      (): void => {
        opened.writeLabelRunBatch(id, 'reply', [labelRecord({ recordType: 'message', recordId: 'm2' })], 1)
      },
    ].map((refused) => {
      try {
        refused()
        return null
      } catch (error: unknown) {
        return error instanceof LogBookError ? [error.code, error.message] : error
      }
    })

    // Assert
    expect({
      refusals,
      tasks: opened.all(RUN_TASKS_READ),
      labels: opened.all('SELECT record_id, name FROM label'),
    }).toStrictEqual({
      refusals: [
        [WAREHOUSE_ERROR_CODES.WAREHOUSE_RUN_TASK_UNKNOWN, `The labelling run ${String(id)} has no task reply.`],
        [WAREHOUSE_ERROR_CODES.WAREHOUSE_RUN_TASK_UNKNOWN, `The labelling run ${String(id)} has no task reply.`],
      ],
      tasks: [{ run_id: id, task: 'prompt', version: 2, planned: 7, done: 1 }],
      labels: [{ record_id: 'test-harness:s1/c1', name: 'act' }],
    })
  })

  it('writes neither the run nor a task when the list names a task twice', async () => {
    // Arrange
    const opened = await openStore()

    // Act
    const starting = (): number => opened.startLabelRun(runStart(['shell', 'prompt', 'shell']))

    // Assert
    expect(starting).toThrow('UNIQUE constraint failed: label_run_task.run_id, label_run_task.task')
    expect({ runs: opened.all('SELECT id FROM label_run'), tasks: opened.all(RUN_TASKS_READ) }).toStrictEqual({
      runs: [],
      tasks: [],
    })
  })

  it("raises each task's done by the records its batches labelled, with their labels written", async () => {
    // Arrange
    const opened = await openStore()
    const id = opened.startLabelRun(runStart(['prompt', 'shell']))

    // Act
    opened.writeLabelRunBatch(
      id,
      'prompt',
      [
        labelRecord({ recordType: 'message', recordId: 'm1', name: 'act' }),
        labelRecord({ recordType: 'reaction', recordId: 'm1:0', name: 'reaction' }),
        labelRecord({ recordType: 'message', recordId: 'm2', name: 'act' }),
      ],
      2
    )
    opened.writeLabelRunBatch(id, 'prompt', [labelRecord({ recordType: 'message', recordId: 'm3', name: 'act' })], 1)
    opened.writeLabelRunBatch(id, 'shell', [labelRecord({ recordId: 'c1', name: 'purpose' })], 1)

    // Assert
    expect({
      done: opened.all('SELECT task, done FROM label_run_task ORDER BY task'),
      labels: opened.all<{ count: number }>('SELECT count(*) AS count FROM label'),
    }).toStrictEqual({
      done: [
        { task: 'prompt', done: 3 },
        { task: 'shell', done: 1 },
      ],
      labels: [{ count: 5 }],
    })
  })

  it('leaves the labels and done unchanged when a batch label insert fails', async () => {
    // Arrange
    const opened = await openStore()
    const id = opened.startLabelRun(runStart(['shell']))
    const broken = { ...labelRecord({ recordId: 'c2' }), labelledAt: 'soon' as unknown as number }

    // Act
    const writing = (): void => {
      opened.writeLabelRunBatch(id, 'shell', [labelRecord({ recordId: 'c1' }), broken], 2)
    }

    // Assert
    expect(writing).toThrow('cannot store TEXT value in INTEGER column label.labelled_at')
    expect({
      tasks: opened.all('SELECT done FROM label_run_task'),
      labels: opened.all('SELECT record_id FROM label'),
    }).toStrictEqual({
      tasks: [{ done: 0 }],
      labels: [],
    })
  })

  it("re-plans only that task's planned", async () => {
    // Arrange
    const opened = await openStore()
    const id = opened.startLabelRun(runStart(['shell', 'session']))
    opened.writeLabelRunBatch(id, 'shell', [labelRecord({})], 1)

    // Act
    opened.replanLabelRunTask(id, 'shell', 40)

    // Assert
    expect(opened.all(RUN_TASKS_READ)).toStrictEqual([
      { run_id: id, task: 'session', version: 2, planned: 10, done: 0 },
      { run_id: id, task: 'shell', version: 2, planned: 40, done: 1 },
    ])
  })

  it.each([
    ['limit', 'You have reached your usage limit.'],
    ['stopped', null],
  ] as const)('ends a run with the outcome %s, its time and its error', async (outcome, error) => {
    // Arrange
    const opened = await openStore()
    const id = opened.startLabelRun(runStart(['shell']))

    // Act
    opened.endLabelRun(id, { endedAt: 9_000, outcome, error })

    // Assert
    expect(opened.all('SELECT ended_at, outcome, error FROM label_run')).toStrictEqual([
      { ended_at: 9_000, outcome, error },
    ])
  })

  it('keeps the run and its tasks when the labels it wrote are dropped', async () => {
    // Arrange
    const opened = await openStore()
    const id = opened.startLabelRun(runStart(['shell']))
    opened.writeLabelRunBatch(id, 'shell', [labelRecord({})], 1)

    // Act
    const dropped = opened.dropLabels('tool_call', 'model-a', ['purpose'])

    // Assert
    expect({
      dropped,
      runs: opened.all('SELECT id FROM label_run'),
      tasks: opened.all('SELECT task, done FROM label_run_task'),
    }).toStrictEqual({ dropped: 1, runs: [{ id }], tasks: [{ task: 'shell', done: 1 }] })
  })
})

const FORGOTTEN_PARENT = 'test-harness:ses_a1'
const FORGOTTEN_IDS = [FORGOTTEN_PARENT, `${FORGOTTEN_PARENT}-child`, `${FORGOTTEN_PARENT}-grandchild`]
// Differs from the forgotten parent only where its id has `_`.
const KEPT = 'test-harness:sesXa1'
const OTHER_PROJECT = 'test-harness:ses_b1'

// Every kind of row the warehouse holds about a session: its import, links, turn, command and labels of the session,
// a message, a tool call and a reaction.
const recordsAbout = (
  sessionId: string
): { turn: ITurnRecord; command: ISessionCommandRecord; labels: ILabelRecord[] } => ({
  turn: { ...turnRecord(`${sessionId}/m1`), sessionId },
  command: { ...commandRecord('review'), sessionId, messageId: `${sessionId}/m1` },
  labels: [
    labelRecord({ recordType: 'session', recordId: sessionId, name: 'outcome' }),
    labelRecord({ recordType: 'message', recordId: `${sessionId}/m1`, name: 'act' }),
    labelRecord({ recordType: 'tool_call', recordId: `${sessionId}/c1`, name: 'purpose' }),
    labelRecord({ recordType: 'reaction', recordId: `${sessionId}/m1#0`, name: 'reaction' }),
  ],
})

const seedForget = (opened: WarehouseStore): void => {
  const sessions = [
    importedSession(FORGOTTEN_PARENT, 'the parent asked about walrus tariffs'),
    importedSession(`${FORGOTTEN_PARENT}-child`, 'the child read walrus tariffs'),
    importedSession(`${FORGOTTEN_PARENT}-grandchild`, 'the grandchild found walrus tariffs'),
    importedSession(KEPT, 'a kept session about penguin budgets'),
    {
      ...importedSession(OTHER_PROJECT, 'another project about otter rates'),
      session: { ...importedSession(OTHER_PROJECT, '').session, projectDir: '/work/other' },
    },
  ]
  opened.writeImportedUnit(sessions, sourceState('fingerprint-1'))
  opened.replaceLinks([
    subagentLink(FORGOTTEN_PARENT, `${FORGOTTEN_PARENT}-child`),
    subagentLink(`${FORGOTTEN_PARENT}-child`, `${FORGOTTEN_PARENT}-grandchild`),
    subagentLink(KEPT, OTHER_PROJECT),
  ])
  const records = [...FORGOTTEN_IDS, KEPT, OTHER_PROJECT].map((id) => recordsAbout(id))
  opened.replaceTurns(records.map((record) => record.turn))
  opened.replaceSessionCommands(records.map((record) => record.command))
  opened.writeLabels(records.flatMap((record) => record.labels))
  const runId = opened.startLabelRun(runStart(['shell']))
  opened.writeLabelRunBatch(runId, 'shell', [], 1)
}

// The tables a session's rows live in; the full-text index is checked by searching it.
const SESSION_TABLES_READ =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'part_fts%' AND name NOT LIKE 'sqlite_%' ORDER BY name"

// The tables, other than forgotten, with a row holding one of the ids.
const tablesHolding = (opened: WarehouseStore, ids: readonly string[]): string[] =>
  opened
    .all<{ name: string }>(SESSION_TABLES_READ)
    .map((row) => row.name)
    .filter((table) => table !== 'forgotten')
    .filter((table) => {
      const text = JSON.stringify(opened.all(`SELECT * FROM ${table}`))
      return ids.some((id) => text.includes(`"${id}`))
    })

describe('WarehouseStore forget', () => {
  let directory = ''
  let store: WarehouseStore | null = null

  const openStore = async (): Promise<WarehouseStore> => {
    store = await WarehouseStore.open(join(directory, 'warehouse.db'))
    return store
  }

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-forget-')))
    vi.stubEnv('XDG_DATA_HOME', join(directory, 'data'))
  })

  afterEach(async () => {
    store?.close()
    store = null
    await rm(directory, { recursive: true, force: true })
  })

  it('forgets a session with its subagent child and grandchild, keeping only their ids in forgotten', async () => {
    // Arrange
    const opened = await openStore()
    seedForget(opened)

    // Act
    const result = opened.forgetSessions([FORGOTTEN_PARENT], 9_000)

    // Assert
    expect({
      result,
      holding: tablesHolding(opened, FORGOTTEN_IDS),
      forgotten: opened.all('SELECT session_id, forgotten_at FROM forgotten ORDER BY session_id'),
    }).toStrictEqual({
      result: { sessionIds: FORGOTTEN_IDS.toSorted(), labelCount: 12 },
      holding: [],
      forgotten: FORGOTTEN_IDS.toSorted().map((id) => ({ session_id: id, forgotten_at: 9_000 })),
    })
  })

  it('keeps every row of the other sessions, their labels included, and the search finds only their text', async () => {
    // Arrange
    const opened = await openStore()
    seedForget(opened)
    const keptRows = (): unknown =>
      opened
        .all<{ name: string }>(SESSION_TABLES_READ)
        .map((row) => row.name)
        .filter((table) => table !== 'forgotten')
        .map((table) => [
          table,
          opened
            .all(`SELECT * FROM ${table}`)
            .filter((row) => JSON.stringify(row).includes(KEPT) || JSON.stringify(row).includes(OTHER_PROJECT)),
        ])
    const before = keptRows()

    // Act
    opened.forgetSessions([FORGOTTEN_PARENT], 9_000)

    // Assert
    expect({
      rows: keptRows(),
      forgottenPhrase: search(opened, 'walrus tariffs'),
      keptPhrase: search(opened, 'penguin budgets'),
      labels: opened.all('SELECT record_id FROM label ORDER BY record_id'),
    }).toStrictEqual({
      rows: before,
      forgottenPhrase: [],
      keptPhrase: [KEPT],
      labels: [
        OTHER_PROJECT,
        `${OTHER_PROJECT}/c1`,
        `${OTHER_PROJECT}/m1`,
        `${OTHER_PROJECT}/m1#0`,
        KEPT,
        `${KEPT}/c1`,
        `${KEPT}/m1`,
        `${KEPT}/m1#0`,
      ]
        .toSorted()
        .map((recordId) => ({ record_id: recordId })),
    })
  })

  it('refuses a known id together with an unknown one, naming the unknown one, and deletes nothing', async () => {
    // Arrange
    const opened = await openStore()
    seedForget(opened)
    const before = counts(opened)

    // Act
    const forgetting = (): unknown => opened.forgetSessions([FORGOTTEN_PARENT, 'test-harness:ses_missing'], 9_000)

    // Assert
    expect(forgetting).toThrow(
      new LogBookError(
        'The warehouse holds no session test-harness:ses_missing.',
        WAREHOUSE_ERROR_CODES.WAREHOUSE_SESSION_UNKNOWN
      )
    )
    expect({ counts: counts(opened), forgotten: opened.all('SELECT session_id FROM forgotten') }).toStrictEqual({
      counts: before,
      forgotten: [],
    })
  })

  it("expands a project directory to that directory's sessions only", async () => {
    // Arrange
    const opened = await openStore()
    seedForget(opened)

    // Act
    const sessions = opened.sessionsInProject('/work/other')

    // Assert
    expect(sessions).toStrictEqual([OTHER_PROJECT])
  })

  it('leaves the source state and the labelling run records as they were', async () => {
    // Arrange
    const opened = await openStore()
    seedForget(opened)
    const read = (): unknown => ({
      sourceState: opened.all('SELECT * FROM source_state'),
      runs: opened.all('SELECT * FROM label_run'),
      tasks: opened.all('SELECT * FROM label_run_task'),
    })
    const before = read()

    // Act
    opened.forgetSessions([FORGOTTEN_PARENT, OTHER_PROJECT], 9_000)

    // Assert
    expect(read()).toStrictEqual(before)
  })
})

describe('WarehouseStore compaction', () => {
  let directory = ''
  let store: WarehouseStore | null = null

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-compact-')))
    vi.stubEnv('XDG_DATA_HOME', join(directory, 'data'))
  })

  afterEach(async () => {
    store?.close()
    store = null
    await rm(directory, { recursive: true, force: true })
  })

  it('still finds a remaining part and none of a deleted one after the full-text index is rewritten', async () => {
    // Arrange
    store = await WarehouseStore.open(join(directory, 'warehouse.db'))
    store.writeImportedUnit(
      [
        importedSession('test-harness:s1', 'the build is green'),
        importedSession('test-harness:s2', 'invoices round up'),
      ],
      sourceState('f1')
    )
    store.writeImportedUnit([importedSession('test-harness:s1', 'the build is red')], sourceState('f2'))

    // Act
    store.optimizeFullText()

    // Assert
    expect({
      remaining: search(store, 'invoices round up'),
      replaced: search(store, 'the build is red'),
      deleted: search(store, 'the build is green'),
    }).toStrictEqual({ remaining: ['test-harness:s2'], replaced: ['test-harness:s1'], deleted: [] })
  })

  it('leaves a 0-byte write-ahead log after the checkpoint that ends the compaction', async () => {
    // Arrange
    const path = join(directory, 'warehouse.db')
    store = await WarehouseStore.open(path)
    store.writeImportedUnit([importedSession('test-harness:s1', 'the build is green')], sourceState('f1'))
    store.writeImportedUnit([importedSession('test-harness:s1', 'the build is red')], sourceState('f2'))
    store.optimizeFullText()
    store.vacuum()

    const pageSize = store.get<{ page_size: number }>('PRAGMA page_size')?.page_size

    // Act
    const isTruncated = store.truncateWal()

    // Assert
    expect({ isTruncated, wal: statSync(`${path}-wal`).size, bytes: store.readFileBytes() }).toStrictEqual({
      isTruncated: true,
      wal: 0,
      bytes: store.readPageCount() * (pageSize ?? Number.NaN),
    })
  })
})
