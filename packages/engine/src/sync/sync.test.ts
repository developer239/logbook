import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IHarnessAdapter, IHarnessDescriptor } from '@log-book/adapter-api'
import { inventedAdapter, type IInventedAdapterOptions } from '@log-book/adapter-api/testing'
import { openSqlite } from '@log-book/core'
import { readSyncLock, takeSyncLock, WarehouseLockHeldError } from '@log-book/warehouse'
import { createTestWarehouse, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeClaude, typeScriptChildArgs } from '../testing/index.js'
import { runSync, type ISyncResult, type SyncProgress } from './sync.js'

const CHILD_TIMEOUT_MS = 10_000
const DRIFT = { seen: '20261001120000_example_change', testedUpTo: '20260923013825_example_tested' }

// Runs a sync whose listing waits for the signal, after writing the ready file, and prints the outcome.
const SYNCING_CHILD = `import { writeFileSync } from 'node:fs'
const [syncUrl, testingUrl, warehousePath, readyFile] = process.argv.slice(2)
const { runSync } = await import(syncUrl)
const { inventedAdapter } = await import(testingUrl)
const base = inventedAdapter()
const adapter = {
  ...base,
  openSource: async (location, context) => {
    const reader = await base.openSource(location, context)
    return {
      ...reader,
      listUnits: async () => {
        writeFileSync(readyFile, '')
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason))
        })
      },
    }
  },
}
const controller = new AbortController()
process.on('SIGTERM', () => controller.abort(new Error('SIGTERM')))
// Nothing else keeps the process alive while the listing waits for the signal.
const keepAlive = setInterval(() => {}, 1000)
const result = await runSync({ adapters: [adapter], warehousePath, onProgress: () => {}, signal: controller.signal })
clearInterval(keepAlive)
process.stdout.write(result.outcome)
`

// The invented adapter under another id, name and alias.
const otherHarness = (
  options: IInventedAdapterOptions,
  descriptor: Partial<IHarnessDescriptor> = {}
): IHarnessAdapter => {
  const adapter = inventedAdapter(options)
  return {
    ...adapter,
    descriptor: {
      ...adapter.descriptor,
      id: 'other-harness',
      name: 'Other Harness',
      filterAlias: 'other',
      ...descriptor,
    },
  }
}

describe('runSync', () => {
  let home = ''
  let warehouse: ITestWarehouse | null = null

  const path = (): string => warehouse?.path ?? ''

  const sync = async (
    adapters: readonly IHarnessAdapter[],
    onProgress: (progress: SyncProgress) => void = () => undefined
  ): Promise<ISyncResult> =>
    runSync({ adapters, warehousePath: path(), onProgress, signal: new AbortController().signal })

  const read = async <TRow>(sql: string): Promise<TRow[]> => {
    const db = await openSqlite(path(), { isReadOnly: true })
    try {
      // node:sqlite returns rows without a prototype.
      return (db.prepare(sql).all() as object[]).map((row) => ({ ...row }) as TRow)
    } finally {
      db.close()
    }
  }

  const records = async (): Promise<unknown[]> =>
    (
      await read<{ ended_at: number | null; outcome: string | null; error: string | null }>(
        'SELECT ended_at, outcome, error FROM sync_run ORDER BY id'
      )
    ).map(({ ended_at: endedAt, outcome, error }) => ({ isEnded: endedAt !== null, outcome, error }))

  const harnessRows = async (): Promise<unknown[]> =>
    read('SELECT id, is_found, location, location_variables, version_seen, notice, problem FROM harness ORDER BY id')

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'log-book-sync-home-')))
    vi.stubEnv('HOME', home)
    warehouse = await createTestWarehouse()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await warehouse?.remove()
    warehouse = null
    await rm(home, { recursive: true, force: true })
  })

  it('holds the sync lock with its pid and operation and an unended record while it runs, then ends ok', async () => {
    // Arrange
    const during: unknown[] = []
    const onProgress = (progress: SyncProgress): void => {
      if (!('phase' in progress)) {
        const lock = readSyncLock(path())
        during.push({ pid: lock.pid, operation: lock.operation, isHeld: lock.isHeld })
      }
    }

    // Act
    const result = await sync([inventedAdapter()], onProgress)

    // Assert
    expect({
      during,
      outcome: result.outcome,
      sessions: result.sessions,
      records: await records(),
      isLockFree: !readSyncLock(path()).isHeld,
    }).toStrictEqual({
      during: [{ pid: process.pid, operation: 'sync', isHeld: true }],
      outcome: 'ok',
      sessions: 1,
      records: [{ isEnded: true, outcome: 'ok', error: null }],
      isLockFree: true,
    })
  })

  it("ends partial when an adapter's source is unreadable, with its problem line, and writes the other adapter", async () => {
    // Act
    const result = await sync([otherHarness({ open: { kind: 'unreadable' } }), inventedAdapter()])

    // Assert
    const line = 'Other Harness: cannot read ~/.invented: Cannot open ~/.invented.'
    expect({
      result: { outcome: result.outcome, problems: result.problems, sessions: result.sessions },
      records: await records(),
      harness: await harnessRows(),
    }).toMatchObject({
      result: { outcome: 'partial', problems: [line], sessions: 1 },
      records: [{ isEnded: true, outcome: 'partial', error: line }],
      harness: [
        { id: 'other-harness', problem: line },
        { id: 'test-harness', problem: null },
      ],
    })
  })

  it('ends partial when one unit is skipped, writing every other unit, with no step problem', async () => {
    // Act
    const result = await sync([
      inventedAdapter({
        listing: {
          kind: 'units',
          units: [{ locator: 'unit-1' }, { locator: 'unit-2', failure: { kind: 'unreadable' } }],
        },
      }),
    ])

    // Assert
    const line = 'Test Harness: 1 units could not be read: unit-2: Cannot read ~/.invented/unit-2.'
    expect({
      problems: result.problems,
      sessions: result.sessions,
      records: await records(),
      harness: await harnessRows(),
    }).toMatchObject({
      problems: [line],
      sessions: 1,
      records: [{ outcome: 'partial', error: line }],
      harness: [{ id: 'test-harness', problem: null }],
    })
  })

  it('ends failed with the last line of the error that ended the whole sync, and throws it', async () => {
    // Act: the host's progress handler throws, an error no adapter step catches
    const syncing = sync([inventedAdapter()], () => {
      throw new Error(`the host broke\nwhile writing ${home}/sync.log`)
    })

    // Assert
    await expect(syncing).rejects.toThrow('the host broke')
    expect({ records: await records(), isLockFree: !readSyncLock(path()).isHeld }).toStrictEqual({
      records: [{ isEnded: true, outcome: 'failed', error: 'while writing ~/sync.log' }],
      isLockFree: true,
    })
  })

  it('writes no record and throws the holder when the lock is held by a live process', async () => {
    // Arrange
    const held = takeSyncLock(path(), 'compact')

    // Act
    const syncing = sync([inventedAdapter()])

    // Assert
    try {
      await expect(syncing).rejects.toBeInstanceOf(WarehouseLockHeldError)
      await expect(syncing).rejects.toMatchObject({ pid: process.pid, operation: 'compact' })
      expect(await records()).toStrictEqual([])
    } finally {
      held.release()
    }
  })

  it('keeps the newest 100 records after 101 syncs', async () => {
    // Arrange
    const adapters = [inventedAdapter()]

    // Act
    await Array.from({ length: 101 }).reduce<Promise<unknown>>(async (previous) => {
      await previous
      return sync(adapters)
    }, Promise.resolve())

    // Assert
    expect(await read('SELECT count(*) AS count FROM sync_run')).toStrictEqual([{ count: 100 }])
  })

  it.each([
    ['SIGTERM', { outcome: 'stopped', isEnded: true }],
    ['SIGKILL', { outcome: null, isEnded: false }],
  ] as const)(
    'leaves the record and the lock as they must be after %s',
    async (signal, expected) => {
      // Arrange
      const child = join(home, 'child.mjs')
      const readyFile = join(home, 'ready')
      const loader = await typeScriptChildArgs(home)
      await writeFile(child, SYNCING_CHILD)
      const running = spawn(
        process.execPath,
        [
          ...loader,
          child,
          new URL('sync.ts', import.meta.url).href,
          import.meta.resolve('@log-book/adapter-api/testing'),
          path(),
          readyFile,
        ],
        { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let stdout = ''
      running.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      const exited = new Promise<void>((resolve) => {
        running.on('exit', () => {
          resolve()
        })
      })
      await vi.waitFor(() => expect(existsSync(readyFile)).toBe(true), { timeout: CHILD_TIMEOUT_MS })

      // Act
      running.kill(signal)
      await exited

      // Assert
      expect({
        stdout,
        records: await records(),
        isLockHeld: readSyncLock(path()).isHeld,
      }).toStrictEqual({
        stdout: signal === 'SIGTERM' ? 'stopped' : '',
        records: [{ isEnded: expected.isEnded, outcome: expected.outcome, error: null }],
        isLockHeld: false,
      })
    },
    CHILD_TIMEOUT_MS * 2
  )

  it('writes each descriptor with its variables and its location in the ~/ form, or NULL', async () => {
    // Arrange
    const adapters = [
      inventedAdapter({
        locationVariables: [{ name: 'INVENTED_HOME', changes: 'Where the invented harness keeps its data' }],
      }),
      otherHarness({ locate: { kind: 'not-found', lookedAt: '.other' } }),
      otherHarness({ locate: { kind: 'not-found', lookedAt: null } }, { id: 'third-harness', filterAlias: 'third' }),
      otherHarness(
        { locate: { kind: 'throws', message: 'locate broke' } },
        { id: 'fourth-harness', filterAlias: 'fourth' }
      ),
    ]

    // Act
    const result = await sync(adapters)

    // Assert
    expect({ harness: await harnessRows(), problems: result.problems }).toStrictEqual({
      harness: [
        {
          id: 'fourth-harness',
          is_found: 0,
          location: null,
          location_variables: '[]',
          version_seen: null,
          notice: null,
          problem: 'Other Harness: skipped this sync, an adapter defect: locate broke',
        },
        {
          id: 'other-harness',
          is_found: 0,
          location: '~/.other',
          location_variables: '[]',
          version_seen: null,
          notice: null,
          problem: null,
        },
        {
          id: 'test-harness',
          is_found: 1,
          location: '~/.invented',
          location_variables: '["INVENTED_HOME"]',
          version_seen: null,
          notice: null,
          problem: null,
        },
        {
          id: 'third-harness',
          is_found: 0,
          location: null,
          location_variables: '[]',
          version_seen: null,
          notice: null,
          problem: null,
        },
      ],
      problems: ['Other Harness: skipped this sync, an adapter defect: locate broke'],
    })
  })

  it('writes the version notice for a unit recorded by a newer version, and ends ok', async () => {
    // Act
    const result = await sync([
      inventedAdapter({ listing: { kind: 'units', units: [{ locator: 'unit-1', harnessVersion: '1.2.0' }] } }),
    ])

    // Assert
    const notice = 'Recorded by Test Harness 1.2.0; this Log Book is tested with 1.0.'
    expect({ outcome: result.outcome, notice: result.adapters[0]?.notice, harness: await harnessRows() }).toMatchObject(
      {
        outcome: 'ok',
        notice,
        harness: [{ version_seen: '1.2.0', notice }],
      }
    )
  })

  it('writes the format notice on an unchanged sync, both sentences with a newer version, and none once both are gone', async () => {
    // Arrange
    const format = `Test Harness data was written in format ${DRIFT.seen}; this Log Book is tested up to ${DRIFT.testedUpTo}.`
    await sync([inventedAdapter()])

    // Act
    const unchanged = await sync([inventedAdapter({ formatDrift: DRIFT })])
    const unchangedNotice = await harnessRows()
    await sync([
      inventedAdapter({
        formatDrift: DRIFT,
        listing: { kind: 'units', units: [{ locator: 'unit-1', fingerprint: 'unit-1@2', harnessVersion: '1.3.0' }] },
      }),
    ])
    const bothNotice = await harnessRows()
    await sync([
      inventedAdapter({
        formatDrift: null,
        listing: { kind: 'units', units: [{ locator: 'unit-1', fingerprint: 'unit-1@3' }] },
      }),
    ])

    // Assert
    expect({
      outcome: unchanged.outcome,
      notices: [unchangedNotice, bothNotice, await harnessRows()].map(
        (rows) => (rows[0] as { notice: string | null }).notice
      ),
    }).toStrictEqual({
      outcome: 'ok',
      notices: [format, `Recorded by Test Harness 1.3.0; this Log Book is tested with 1.0. ${format}`, null],
    })
  })

  it('reports every unit with the re-read flag through a parser bump, then the derivations phase', async () => {
    // Arrange
    const units = { kind: 'units', units: [{ locator: 'unit-1' }, { locator: 'unit-2' }] } as const
    await sync([inventedAdapter({ listing: units })])
    const bumped: SyncProgress[] = []
    const after: SyncProgress[] = []

    // Act
    await sync([inventedAdapter({ listing: units, parserVersion: 2 })], (progress) => bumped.push(progress))
    await sync([inventedAdapter({ listing: units, parserVersion: 2 })], (progress) => after.push(progress))

    // Assert
    expect({ bumped, after }).toStrictEqual({
      bumped: [
        { adapter: 'test-harness', done: 1, total: 2, reread: true },
        { adapter: 'test-harness', done: 2, total: 2, reread: true },
        { phase: 'derivations' },
      ],
      after: [
        { adapter: 'test-harness', done: 1, total: 2, reread: false },
        { adapter: 'test-harness', done: 2, total: 2, reread: false },
        { phase: 'derivations' },
      ],
    })
  })

  it('runs the derivations in order: a recovery reads a shell purpose written in the same sync', async () => {
    // Arrange
    const adapter = inventedAdapter({
      listing: {
        kind: 'units',
        units: [
          {
            locator: 'unit-1',
            sessions: [
              {
                messages: [
                  { actor: 'user', text: 'run the tests', at: 1_000 },
                  {
                    actor: 'assistant',
                    text: 'Running.',
                    at: 2_000,
                    toolCalls: [
                      {
                        name: 'Bash',
                        family: 'shell',
                        input: { command: 'pnpm test' },
                        status: 'error',
                        result: '1 failed',
                      },
                    ],
                  },
                  {
                    actor: 'assistant',
                    text: 'Again.',
                    at: 3_000,
                    toolCalls: [
                      {
                        name: 'Bash',
                        family: 'shell',
                        input: { command: 'pnpm test' },
                        status: 'completed',
                        result: 'all passed',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    })

    // Act
    await sync([adapter])

    // Assert
    expect(
      await read("SELECT name, value FROM label WHERE record_type = 'tool_call' ORDER BY record_id, name")
    ).toStrictEqual([
      { name: 'purpose', value: 'run tests' },
      { name: 'recovery', value: 'recovered' },
      { name: 'purpose', value: 'run tests' },
    ])
  })

  it('starts no claude process', async () => {
    // Arrange
    const bin = await mkdtemp(join(home, 'bin-'))
    const fake = await installFakeClaude(bin)
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`)

    // Act
    await sync([inventedAdapter()])

    // Assert
    expect(await fake.readRecords()).toStrictEqual([])
  })

  it("holds the adapter's id only in its id columns and in ids", async () => {
    // Arrange
    await sync([inventedAdapter()])
    const tables = await read<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'part_fts%'"
    )

    // Act
    const leaks = (
      await Promise.all(
        tables.map(async ({ name }) =>
          (await read<Record<string, unknown>>(`SELECT * FROM ${name}`)).flatMap((row) =>
            Object.entries(row)
              .filter(
                ([column, value]) =>
                  !/(?:^|_)id$|^harness$/u.test(column) && typeof value === 'string' && value.includes('test-harness')
              )
              .map(([column]) => `${name}.${column}`)
          )
        )
      )
    ).flat()

    // Assert
    expect(leaks).toStrictEqual([])
  })
})
