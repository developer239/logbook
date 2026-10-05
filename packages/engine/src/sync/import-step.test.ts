import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ADAPTER_ERROR_CODES, type IAdapterEnvironment, type IHarnessAdapter } from '@log-book/adapter-api'
import {
  inventedAdapter,
  type IInventedAdapter,
  type IInventedAdapterOptions,
  type IInventedUnit,
  type InventedListing,
} from '@log-book/adapter-api/testing'
import { WarehouseStore } from '@log-book/warehouse'
import { createTestWarehouse, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importAdapter, locateAdapters, type IImportReport, type IUnitProgress } from './import-step.js'

const IMPORTED_AT = 5_000
const DRIFT = { seen: '20261001120000_example_change', testedUpTo: '20260923013825_example_tested' }

interface IStepRun {
  reports: IImportReport[]
  progress: IUnitProgress[]
  log: string[]
}

const units = (...locators: string[]): InventedListing => ({
  kind: 'units',
  units: locators.map((locator) => ({ locator })),
})

const listing = (...listed: IInventedUnit[]): InventedListing => ({ kind: 'units', units: listed })

const methods = (adapter: IInventedAdapter): string[] =>
  adapter.calls.map((call) =>
    call.method === 'importUnit' ? `importUnit ${(call.args[0] as { locator: string }).locator}` : call.method
  )

// An adapter of another harness: the invented adapter under another id and alias.
const otherHarness = (options: IInventedAdapterOptions): IHarnessAdapter => {
  const adapter = inventedAdapter(options)
  return { ...adapter, descriptor: { ...adapter.descriptor, id: 'other-harness', filterAlias: 'other' } }
}

describe('the import step', () => {
  let directory = ''
  let warehouse: ITestWarehouse | null = null
  let store: WarehouseStore | null = null
  let env: IAdapterEnvironment = { variables: {}, homeDir: '', cwd: '', platform: 'linux' }

  const openStore = (): WarehouseStore => {
    if (store === null) {
      throw new Error('The store is not open.')
    }
    return store
  }

  // Locates every adapter, then runs each found adapter's step in order, as a sync does.
  const runStep = async (
    adapters: readonly IHarnessAdapter[],
    signal = new AbortController().signal
  ): Promise<IStepRun> => {
    const run: IStepRun = { reports: [], progress: [], log: [] }
    const located = await locateAdapters(adapters, env)
    // The steps run one after another, as a sync runs them.
    await located.reduce(async (previous, adapter) => {
      await previous
      run.reports.push(
        await importAdapter(adapter, {
          store: openStore(),
          signal,
          now: () => IMPORTED_AT,
          onProgress: (progress) => run.progress.push(progress),
          log: (line) => run.log.push(line),
        })
      )
    }, Promise.resolve())
    return run
  }

  const sessionIds = (): string[] =>
    openStore()
      .all<{ id: string }>('SELECT id FROM session ORDER BY id')
      .map((row) => row.id)

  const sourceStates = (): unknown[] =>
    openStore().all('SELECT locator, fingerprint, parser_version, imported_at FROM source_state ORDER BY locator')

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-import-step-')))
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

  it('does not import an unchanged unit and imports one whose fingerprint changed', async () => {
    // Arrange
    await runStep([inventedAdapter({ listing: units('unit-1', 'unit-2') })])
    const adapter = inventedAdapter({
      listing: listing({ locator: 'unit-1' }, { locator: 'unit-2', fingerprint: 'unit-2@2' }),
    })

    // Act
    const { reports } = await runStep([adapter])

    // Assert
    expect({
      calls: methods(adapter),
      counts: reports.map(({ imported, unchanged, gone, skipped, isReread }) => ({
        imported,
        unchanged,
        gone,
        skipped,
        isReread,
      })),
      states: sourceStates(),
    }).toStrictEqual({
      calls: ['locate', 'openSource', 'listUnits', 'importUnit unit-2', 'close'],
      counts: [{ imported: 1, unchanged: 1, gone: 0, skipped: 0, isReread: false }],
      states: [
        { locator: 'unit-1', fingerprint: 'unit-1@1', parser_version: 1, imported_at: IMPORTED_AT },
        { locator: 'unit-2', fingerprint: 'unit-2@2', parser_version: 1, imported_at: IMPORTED_AT },
      ],
    })
  })

  it('imports every listed unit again after a parser version bump, and says so', async () => {
    // Arrange
    await runStep([inventedAdapter({ listing: units('unit-1', 'unit-2') })])
    const adapter = inventedAdapter({ listing: units('unit-1', 'unit-2'), parserVersion: 2 })

    // Act
    const { reports, progress } = await runStep([adapter])

    // Assert
    expect({ calls: methods(adapter), isReread: reports[0]?.isReread, progress }).toStrictEqual({
      calls: ['locate', 'openSource', 'listUnits', 'importUnit unit-1', 'importUnit unit-2', 'close'],
      isReread: true,
      progress: [
        { adapter: 'test-harness', done: 1, total: 2, reread: true },
        { adapter: 'test-harness', done: 2, total: 2, reread: true },
      ],
    })
  })

  it('counts a unit gone while reading, keeps its rows, and reports no problem', async () => {
    // Arrange
    await runStep([inventedAdapter({ listing: units('unit-1') })])
    const adapter = inventedAdapter({
      listing: listing({ locator: 'unit-1', fingerprint: 'unit-1@2', failure: { kind: 'gone' } }),
    })

    // Act
    const { reports } = await runStep([adapter])

    // Assert
    expect({
      gone: reports[0]?.gone,
      problems: reports[0]?.problems,
      sessions: sessionIds(),
      states: sourceStates(),
    }).toStrictEqual({
      gone: 1,
      problems: [],
      sessions: ['test-harness:unit-1'],
      states: [{ locator: 'unit-1', fingerprint: 'unit-1@1', parser_version: 1, imported_at: IMPORTED_AT }],
    })
  })

  it('skips an unreadable unit with a problem, keeps its source state, and writes the other units', async () => {
    // Arrange
    await runStep([inventedAdapter({ listing: units('unit-1') })])
    const adapter = inventedAdapter({
      listing: listing(
        { locator: 'unit-1', fingerprint: 'unit-1@2', failure: { kind: 'unreadable' } },
        { locator: 'unit-2' },
        { locator: 'unit-3', failure: { kind: 'unreadable' } }
      ),
    })

    // Act
    const { reports } = await runStep([adapter])

    // Assert
    expect({ report: reports[0], sessions: sessionIds(), states: sourceStates() }).toMatchObject({
      report: {
        imported: 1,
        skipped: 2,
        problems: [
          {
            code: ADAPTER_ERROR_CODES.ADAPTER_UNIT_UNREADABLE,
            units: 2,
            firstLocator: 'unit-1',
            reason: `Cannot read ${join(directory, '.invented', 'unit-1')}.`,
          },
        ],
      },
      sessions: ['test-harness:unit-1', 'test-harness:unit-2'],
      states: [
        { locator: 'unit-1', fingerprint: 'unit-1@1' },
        { locator: 'unit-2', fingerprint: 'unit-2@1' },
      ],
    })
  })

  it('skips a unit that breaks a validation rule, naming the rule, and writes the other units', async () => {
    // Arrange
    const adapter = inventedAdapter({
      listing: listing(
        { locator: 'unit-1', failure: { kind: 'invalid', rule: 'empty-part-text' } },
        { locator: 'unit-2' }
      ),
    })

    // Act
    const { reports, log } = await runStep([adapter])

    // Assert
    const [problem] = reports[0]?.problems ?? []
    expect({
      skipped: reports[0]?.skipped,
      code: problem?.code,
      firstLocator: problem?.firstLocator,
      isRuleNamed: log.some(
        (line) => line.startsWith('test-harness unit-1: ') && line.includes(problem?.reason ?? '-')
      ),
      sessions: sessionIds(),
    }).toStrictEqual({
      skipped: 1,
      code: ADAPTER_ERROR_CODES.ADAPTER_OUTPUT_INVALID,
      firstLocator: 'unit-1',
      isRuleNamed: true,
      sessions: ['test-harness:unit-2'],
    })
  })

  it('ends the step with a problem when two units share a locator', async () => {
    // Arrange
    const adapter = inventedAdapter({ listing: units('unit-1', 'unit-1') })

    // Act
    const { reports } = await runStep([adapter])

    // Assert
    expect({ calls: methods(adapter), problems: reports[0]?.problems, sessions: sessionIds() }).toStrictEqual({
      calls: ['locate', 'openSource', 'listUnits', 'close'],
      problems: [
        {
          code: ADAPTER_ERROR_CODES.ADAPTER_OUTPUT_INVALID,
          units: 0,
          firstLocator: 'unit-1',
          reason: 'two units share the locator unit-1',
        },
      ],
      sessions: [],
    })
  })

  it('imports one adapter normally while another raises ADAPTER_FORMAT_UNSUPPORTED', async () => {
    // Arrange
    const broken = otherHarness({ open: { kind: 'unsupported' } })

    // Act
    const { reports } = await runStep([broken, inventedAdapter()])

    // Assert
    expect({
      reports: reports.map(({ adapter, imported, problems }) => ({
        adapter,
        imported,
        codes: problems.map((problem) => problem.code),
      })),
      sessions: sessionIds(),
    }).toStrictEqual({
      reports: [
        { adapter: 'other-harness', imported: 0, codes: [ADAPTER_ERROR_CODES.ADAPTER_FORMAT_UNSUPPORTED] },
        { adapter: 'test-harness', imported: 1, codes: [] },
      ],
      sessions: ['test-harness:unit-1'],
    })
  })

  it('closes the reader after a listing that threw, and has none to close when openSource threw', async () => {
    // Arrange
    const listingThrows = inventedAdapter({ listing: { kind: 'throws', message: 'the listing broke' } })
    const openThrows = otherHarness({ open: { kind: 'unreadable' } })

    // Act
    const { reports } = await runStep([listingThrows, openThrows])

    // Assert
    expect({
      listingCalls: methods(listingThrows),
      openCalls: methods(openThrows as IInventedAdapter),
      problems: reports.map((report) => report.problems.map(({ code, reason }) => ({ code, reason }))),
    }).toStrictEqual({
      listingCalls: ['locate', 'openSource', 'listUnits', 'close'],
      openCalls: ['locate', 'openSource'],
      problems: [
        [{ code: null, reason: 'the listing broke' }],
        [
          {
            code: ADAPTER_ERROR_CODES.ADAPTER_SOURCE_UNREADABLE,
            reason: `Cannot open ${join(directory, '.invented')}.`,
          },
        ],
      ],
    })
  })

  it.each([
    [
      'not found with a path',
      { kind: 'not-found', lookedAt: '.invented' } as const,
      { lookedAt: '.invented', problems: [] },
    ],
    ['not found with no path', { kind: 'not-found', lookedAt: null } as const, { lookedAt: null, problems: [] }],
    [
      'a locate that throws',
      { kind: 'throws', message: 'locate broke' } as const,
      { lookedAt: null, problems: [{ code: null, units: 0, firstLocator: null, reason: 'locate broke' }] },
    ],
  ])('ends the step of an adapter %s without opening it', async (_case, locate, expected) => {
    // Arrange
    const adapter = inventedAdapter({ locate })

    // Act
    const { reports } = await runStep([adapter])

    // Assert
    expect({ calls: methods(adapter), report: reports[0] }).toMatchObject({
      calls: ['locate'],
      report: {
        isFound: false,
        location: null,
        lookedAt: expected.lookedAt === null ? null : join(directory, expected.lookedAt),
        problems: expected.problems,
      },
    })
  })

  it("leaves out a forgotten session and writes its unit's other sessions", async () => {
    // Arrange
    warehouse?.db
      .prepare('INSERT INTO forgotten (session_id, forgotten_at) VALUES (?, ?)')
      .run('test-harness:forgotten', 1)
    const adapter = inventedAdapter({
      listing: listing({ locator: 'unit-1', sessions: [{ sourceId: 'forgotten' }, { sourceId: 'kept' }] }),
    })

    // Act
    await runStep([adapter])

    // Assert
    expect(sessionIds()).toStrictEqual(['test-harness:kept'])
  })

  it('keeps the sessions and labels of a unit no longer listed', async () => {
    // Arrange
    await runStep([inventedAdapter({ listing: units('unit-1', 'unit-2') })])
    openStore().writeLabels([
      {
        recordType: 'session',
        recordId: 'test-harness:unit-2',
        labeller: 'model-a',
        version: 1,
        name: 'outcome',
        value: 'done',
        labelledAt: 1,
      },
    ])

    // Act
    await runStep([inventedAdapter({ listing: units('unit-1') })])

    // Assert
    expect({ sessions: sessionIds(), labels: openStore().all('SELECT record_id FROM label') }).toStrictEqual({
      sessions: ['test-harness:unit-1', 'test-harness:unit-2'],
      labels: [{ record_id: 'test-harness:unit-2' }],
    })
  })

  it('counts unknown records by type and reports the newest harness version', async () => {
    // Arrange
    const adapter = inventedAdapter({
      listing: listing(
        { locator: 'unit-1', harnessVersion: '1.10.1', sessions: [{ unknownRecords: [{ alpha: 1 }, { beta: 2 }] }] },
        { locator: 'unit-2', harnessVersion: '1.9.4', sessions: [{ unknownRecords: [{ gamma: 3 }] }] }
      ),
    })

    // Act
    const { reports } = await runStep([adapter])

    // Assert
    expect({ unknown: reports[0]?.unknownByType, version: reports[0]?.versionSeen }).toStrictEqual({
      unknown: { invented: 3 },
      version: '1.10.1',
    })
  })

  it('reports a format drift on a sync with nothing changed and on one whose listing throws, and still imports', async () => {
    // Arrange
    const first = await runStep([inventedAdapter({ formatDrift: DRIFT })])

    // Act
    const unchanged = await runStep([inventedAdapter({ formatDrift: DRIFT })])
    const listingThrows = await runStep([
      inventedAdapter({ formatDrift: DRIFT, listing: { kind: 'throws', message: 'broke' } }),
    ])
    const none = await runStep([
      inventedAdapter({ formatDrift: null, listing: listing({ locator: 'unit-1', fingerprint: 'unit-1@2' }) }),
    ])

    // Assert
    expect(
      [first, unchanged, listingThrows, none].map(({ reports: [report] }) => [report?.formatDrift, report?.imported])
    ).toStrictEqual([
      [DRIFT, 1],
      [DRIFT, 0],
      [DRIFT, 0],
      [null, 1],
    ])
  })

  it('stops at an abort between two units, with the first unit written and the reader closed', async () => {
    // Arrange
    const controller = new AbortController()
    const reason = new Error('stopped by the user')
    const adapter = inventedAdapter({ listing: units('unit-1', 'unit-2') })
    const located = await locateAdapters([adapter], env)

    // Act
    const stepping = importAdapter(located[0] ?? { kind: 'not-found', adapter, lookedAt: null, problem: null }, {
      store: openStore(),
      signal: controller.signal,
      now: () => IMPORTED_AT,
      onProgress: () => {
        controller.abort(reason)
      },
      log: () => undefined,
    })

    // Assert
    await expect(stepping).rejects.toBe(reason)
    expect({ calls: methods(adapter), sessions: sessionIds() }).toStrictEqual({
      calls: ['locate', 'openSource', 'listUnits', 'importUnit unit-1', 'close'],
      sessions: ['test-harness:unit-1'],
    })
  })
})
