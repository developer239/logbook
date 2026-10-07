import { describe, expect, it } from 'vitest'
import { descriptorProblems } from '../conformance/descriptor.js'
import type { IAdapterEnvironment, IHarnessAdapter, IImportedUnit, ISourceReader } from '../contract.js'
import { ADAPTER_ERROR_CODES } from '../helpers.js'
import { validateImportedUnit } from '../validate.js'
import { inventedAdapter, type IInventedAdapterOptions } from './index.js'

const ENV: IAdapterEnvironment = { variables: {}, homeDir: '/home/example', cwd: '/home/example', platform: 'linux' }
const DRIFT = { seen: '20261001120000_example_change', testedUpTo: '20260923013825_example_base' }

const context = (): { signal: AbortSignal; onProgress: () => void; openSqlite: never } => ({
  signal: new AbortController().signal,
  onProgress: () => undefined,
  openSqlite: undefined as never,
})

const openReader = async (adapter: IHarnessAdapter): Promise<ISourceReader> => {
  const located = await adapter.locate(ENV)
  if (located.kind !== 'found') {
    throw new Error('The invented harness was not found')
  }
  return adapter.openSource(located.location, context())
}

const importAll = async (adapter: IHarnessAdapter): Promise<IImportedUnit[]> => {
  const reader = await openReader(adapter)
  const units = await reader.listUnits()
  const imported = await Promise.all(units.map(async (unit) => reader.importUnit(unit)))
  await reader.close()
  return imported
}

const codeOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof Error && 'code' in error ? error.code : `plain: ${String(error)}`)
  )

describe('inventedAdapter', () => {
  it('gives with default options one unit that passes validateImportedUnit', async () => {
    // Arrange
    const adapter = inventedAdapter()

    // Act
    const imported = await importAll(adapter)

    // Assert
    expect(imported.map((unit) => validateImportedUnit(adapter.descriptor, unit))).toStrictEqual([[]])
  })

  it('builds sessions with tool calls, results and unknown records that pass validateImportedUnit', async () => {
    // Arrange
    const adapter = inventedAdapter({
      listing: {
        kind: 'units',
        units: [
          {
            locator: 'projects/shop/s1.jsonl',
            harnessVersion: '1.0.4',
            sessions: [
              {
                projectDir: '/home/example/work/shop',
                title: 'Add a discount code',
                messages: [
                  { actor: 'user', text: 'run the tests', at: 1_000 },
                  {
                    actor: 'assistant',
                    text: 'Running them.',
                    at: 2_000,
                    model: 'model-a',
                    toolCalls: [
                      { name: 'Bash', family: 'shell', input: { command: 'pnpm test' }, result: 'all passed' },
                      { name: 'mcp__docs__search', family: 'mcp:docs', input: { query: 'coupons' }, status: 'error' },
                    ],
                  },
                ],
                unknownRecords: [{ type: 'mystery' }],
              },
            ],
          },
        ],
      },
    })

    // Act
    const [unit] = await importAll(adapter)

    // Assert
    expect({
      problems: unit === undefined ? ['no unit'] : validateImportedUnit(adapter.descriptor, unit),
      counts: unit?.sessions.map((session) => [
        session.messages.length,
        session.parts.length,
        session.toolCalls.length,
        session.events.length,
      ]),
      sessionId: unit?.sessions[0]?.session.id,
      harnessVersion: unit?.harnessVersion,
    }).toStrictEqual({
      problems: [],
      counts: [[3, 5, 2, 1]],
      sessionId: 'test-harness:projects-shop-s1.jsonl',
      harnessVersion: '1.0.4',
    })
  })

  it('keeps every descriptor rule by default, and shows a set name and unit noun as given', () => {
    // Arrange
    const defaults = inventedAdapter().descriptor

    // Act
    const named = inventedAdapter({ name: 'Other Harness', unitNoun: 'transcripts' }).descriptor

    // Assert
    expect({
      problems: descriptorProblems(defaults),
      unitNoun: defaults.unitNoun,
      named: [named.id, named.name, named.unitNoun],
    }).toStrictEqual({ problems: [], unitNoun: 'units', named: ['test-harness', 'Other Harness', 'transcripts'] })
  })

  it.each([
    ['nothing', undefined, [null, null, null]],
    ['one drift', DRIFT, [DRIFT, DRIFT, DRIFT]],
    ['the list [drift, null]', [DRIFT, null], [DRIFT, null, null]],
  ] as const)('gives each reader its drift for %s', async (_given, formatDrift, expected) => {
    // Arrange
    const options: IInventedAdapterOptions = formatDrift === undefined ? {} : { formatDrift }
    const adapter = inventedAdapter(options)

    // Act
    const drifts = [
      (await openReader(adapter)).formatDrift,
      (await openReader(adapter)).formatDrift,
      (await openReader(adapter)).formatDrift,
    ]

    // Assert
    expect(drifts).toStrictEqual(expected)
  })

  it('lists and imports the same units with a drift, and its listing still throws when told', async () => {
    // Arrange
    const plain = inventedAdapter()
    const drifting = inventedAdapter({ formatDrift: DRIFT })
    const failing = inventedAdapter({ formatDrift: DRIFT, listing: { kind: 'throws', message: 'listing failed' } })

    // Act
    const listing = (await openReader(failing)).listUnits()

    // Assert
    expect({ drifting: await importAll(drifting), listing: await codeOf(listing) }).toStrictEqual({
      drifting: await importAll(plain),
      listing: 'plain: Error: listing failed',
    })
  })

  it.each([
    ['locate throws', { locate: { kind: 'throws', message: 'no home' } }, 'locate', 'plain: Error: no home'],
    ['open unreadable', { open: { kind: 'unreadable' } }, 'openSource', ADAPTER_ERROR_CODES.ADAPTER_SOURCE_UNREADABLE],
    [
      'open unsupported',
      { open: { kind: 'unsupported' } },
      'openSource',
      ADAPTER_ERROR_CODES.ADAPTER_FORMAT_UNSUPPORTED,
    ],
    ['open throws', { open: { kind: 'throws', message: 'broken' } }, 'openSource', 'plain: Error: broken'],
    [
      'unit gone',
      { listing: { kind: 'units', units: [{ locator: 'u1', failure: { kind: 'gone' } }] } },
      'importUnit',
      ADAPTER_ERROR_CODES.ADAPTER_UNIT_GONE,
    ],
    [
      'unit unreadable',
      { listing: { kind: 'units', units: [{ locator: 'u1', failure: { kind: 'unreadable' } }] } },
      'importUnit',
      ADAPTER_ERROR_CODES.ADAPTER_UNIT_UNREADABLE,
    ],
    [
      'unit throws',
      { listing: { kind: 'units', units: [{ locator: 'u1', failure: { kind: 'throws', message: 'bad line' } }] } },
      'importUnit',
      'plain: Error: bad line',
    ],
    [
      'commands throw',
      { commands: { kind: 'throws', message: 'no commands' } },
      'prepareCommands',
      'plain: Error: no commands',
    ],
  ] as const)('raises at the right method for %s', async (_failure, options, method, expected) => {
    // Arrange
    const adapter = inventedAdapter(options)
    const steps = {
      locate: async () => adapter.locate(ENV),
      openSource: async () => openReader(adapter),
      importUnit: async () => importAll(adapter),
      prepareCommands: async () => adapter.prepareCommands(null, ENV, []),
    }

    // Act
    const outcome = await codeOf(steps[method]())

    // Assert
    expect({ outcome, lastCall: adapter.calls.at(-1)?.method }).toStrictEqual({ outcome: expected, lastCall: method })
  })

  it.each([
    ['unknown-actor', 'actor narrator is not a known actor'],
    ['empty-part-text', 'text is empty'],
    ['adapter-id-in-source-id', 'sourceId contains the adapter id'],
    ['duplicate-seq', 'seq 0 is not unique in its session'],
  ] as const)('returns output that breaks the rule %s', async (rule, problem) => {
    // Arrange
    const adapter = inventedAdapter({
      listing: { kind: 'units', units: [{ locator: 'u1', failure: { kind: 'invalid', rule } }] },
    })

    // Act
    const [unit] = await importAll(adapter)

    // Assert
    expect(
      (unit === undefined ? [] : validateImportedUnit(adapter.descriptor, unit)).some((found) =>
        found.endsWith(problem)
      )
    ).toBe(true)
  })

  it('logs every call in order across a listing that throws', async () => {
    // Arrange
    const adapter = inventedAdapter({ listing: { kind: 'throws', message: 'listing failed' } })
    const reader = await openReader(adapter)

    // Act
    await reader.listUnits().catch(() => undefined)
    await reader.close()

    // Assert
    expect(adapter.calls.map((call) => call.method)).toStrictEqual(['locate', 'openSource', 'listUnits', 'close'])
  })

  it('logs no close when openSource throws, and the unit each import was given', async () => {
    // Arrange
    const failing = inventedAdapter({ open: { kind: 'unreadable' } })
    const importing = inventedAdapter()

    // Act
    await openReader(failing).catch(() => undefined)
    await importAll(importing)

    // Assert
    expect({
      failing: failing.calls.map((call) => call.method),
      imported: importing.calls.filter((call) => call.method === 'importUnit').map((call) => call.args),
    }).toStrictEqual({
      failing: ['locate', 'openSource'],
      imported: [[{ locator: 'unit-1', fingerprint: 'unit-1@1' }]],
    })
  })

  it('gives a changing fingerprint a different value on each listing and keeps a fixed one', async () => {
    // Arrange
    const adapter = inventedAdapter({
      listing: {
        kind: 'units',
        units: [
          { locator: 'live', isFingerprintChanging: true },
          { locator: 'done', fingerprint: 'fixed' },
        ],
      },
    })
    const reader = await openReader(adapter)

    // Act
    const listings = [await reader.listUnits(), await reader.listUnits()]

    // Assert
    expect(listings.map((units) => units.map((unit) => unit.fingerprint))).toStrictEqual([
      ['live@1#1', 'fixed'],
      ['live@1#2', 'fixed'],
    ])
  })

  it.each([
    ['null', null, null],
    ['a path', '.invented/data', '/home/example/.invented/data'],
  ] as const)('answers not-found with lookedAt %s', async (_given, lookedAt, expected) => {
    // Arrange
    const adapter = inventedAdapter({ locate: { kind: 'not-found', lookedAt } })

    // Act
    const result = await adapter.locate(ENV)

    // Assert
    expect(result).toStrictEqual({ kind: 'not-found', lookedAt: expected })
  })

  it('recognises the prompts it was given and no others', async () => {
    // Arrange
    const release = { command: 'release', source: 'typed', hasFile: true } as const
    const adapter = inventedAdapter({ commands: { kind: 'recognises', prompts: { '/release now': release } } })

    // Act
    const recogniser = await adapter.prepareCommands(null, ENV, [])

    // Assert
    expect([
      recogniser.recognise({ actor: 'user', text: '/release now', projectDir: null }),
      recogniser.recognise({ actor: 'user', text: 'hello', projectDir: null }),
    ]).toStrictEqual([release, null])
  })
})
