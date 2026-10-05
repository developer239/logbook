import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isErrnoCode } from '@log-book/core'
import { WarehouseStore } from '@log-book/warehouse'
import { createTestWarehouse } from '@log-book/warehouse/testing'
import type { IHarnessAdapter, IPrompt, IRecognisedCommand } from '../contract.js'
import { ADAPTER_ERROR_CODES } from '../helpers.js'
import { validateImportedUnit } from '../validate.js'
import { descriptorProblems } from './descriptor.js'
import type { IConformanceCase, IFixtureSet, ILocateVariant } from './fixture-set.js'
import { goldenText, isUpdatingGolden, readGolden, writeGolden } from './golden.js'
import { expectedDirectory, hashFile, hashTree, withEmptyHome, withFixtureHome, withLiveHome } from './home.js'
import { adapterContext, importEvery, importHome, locateFound, withReader, type IListedImport } from './session.js'

type TCaseRun = (adapter: IHarnessAdapter, fixture: IFixtureSet, fixtures: readonly IFixtureSet[]) => Promise<void>

interface ICommandExpectation {
  prompt: IPrompt
  expected: IRecognisedCommand | null
}

const isUnder = (home: string, path: string): boolean => isAbsolute(path) && path.startsWith(`${home}${sep}`)

const byLocator = <TValue>(
  imports: readonly IListedImport[],
  value: (listed: IListedImport) => TValue
): Record<string, TValue> => Object.fromEntries(imports.map((listed) => [listed.unit.locator, value(listed)]))

const readCommandExpectations = async (fixture: IFixtureSet, home: string): Promise<ICommandExpectation[]> => {
  const text = await readFile(join(expectedDirectory(fixture), 'commands.json'), 'utf8')
  return (JSON.parse(text) as ICommandExpectation[]).map(({ prompt, expected }) => ({
    prompt: { ...prompt, projectDir: prompt.projectDir === null ? null : join(home, prompt.projectDir) },
    expected,
  }))
}

const projectDirsOf = (expectations: readonly ICommandExpectation[]): string[] => [
  ...new Set(expectations.flatMap(({ prompt }) => (prompt.projectDir === null ? [] : [prompt.projectDir]))),
]

// Every string of a record, except the session's harness and every id, which carry the adapter id by design.
// An event's data is checked as the document it holds, so its own id fields are skipped too.
const parsedData = (key: string, value: string): unknown => {
  if (key !== 'dataJson') {
    return value
  }
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

const leakingFields = (value: unknown, adapterId: string, path: string): string[] => {
  const key = path.split('.').at(-1) ?? ''
  const data = typeof value === 'string' ? parsedData(key, value) : value
  if (typeof data === 'string') {
    return data.includes(adapterId) ? [path] : []
  }
  if (data !== value) {
    return leakingFields(data, adapterId, `${path}.data`)
  }
  if (typeof value !== 'object' || value === null) {
    return []
  }
  return Object.entries(value).flatMap(([key, item]) =>
    key === 'harness' || key === 'id' || key.endsWith('Id') ? [] : leakingFields(item, adapterId, `${path}.${key}`)
  )
}

const unknownHolds = (dataJson: string, record: unknown): boolean => {
  const description = JSON.parse(dataJson) as { what: string; raw?: unknown; value?: unknown }
  return isDeepStrictEqual(description.what === 'field' ? description.value : description.raw, record)
}

const descriptorCase: TCaseRun = (adapter, _fixture, fixtures) => {
  assert.deepEqual(
    {
      problems: descriptorProblems(adapter.descriptor),
      testedVersions: adapter.descriptor.testedVersions.toSorted(),
    },
    { problems: [], testedVersions: fixtures.map((set) => set.harnessVersion).toSorted() }
  )
  return Promise.resolve()
}

const locateFoundCase: TCaseRun = async (adapter, fixture) =>
  withFixtureHome(fixture, async (home) => {
    const location = await locateFound(adapter, fixture.environment(home))
    assert.deepEqual(
      { kind: location.kind, isUnderHome: isUnder(home, location.root) || location.root === home },
      { kind: fixture.locationKind, isUnderHome: true }
    )
  })

const locateAbsentCase: TCaseRun = async (adapter, fixture) =>
  withEmptyHome(async (home) => {
    const result = await adapter.locate({ ...fixture.environment(home), variables: {} })
    assert.deepEqual(
      {
        kind: result.kind,
        isUnderHome: result.kind === 'not-found' && result.lookedAt !== null && isUnder(home, result.lookedAt),
      },
      { kind: 'not-found', isUnderHome: true }
    )
  })

const readOnlyCase: TCaseRun = async (adapter, fixture) =>
  withFixtureHome(fixture, async (home) => {
    const before = await hashTree(home)
    const env = fixture.environment(home)
    const location = await locateFound(adapter, env)
    await withReader(adapter, location, importEvery)
    await adapter.prepareCommands(location, env, projectDirsOf(await readCommandExpectations(fixture, home)))
    assert.deepEqual(await hashTree(home), before)
  })

const listingCase: TCaseRun = async (adapter, fixture) =>
  withFixtureHome(fixture, async (home) => {
    const location = await locateFound(adapter, fixture.environment(home))
    const { first, second } = await withReader(adapter, location, async (reader) => ({
      first: await reader.listUnits(),
      second: await reader.listUnits(),
    }))
    const locators = first.map((unit) => unit.locator)
    assert.deepEqual(
      {
        areUnique: new Set(locators).size === locators.length,
        areRelative: locators.every((locator) => locator !== '' && !isAbsolute(locator)),
        areFingerprinted: first.every((unit) => unit.fingerprint !== ''),
        second,
      },
      { areUnique: true, areRelative: true, areFingerprinted: true, second: first }
    )
  })

const fingerprintChangeCase: TCaseRun = async (adapter, fixture) =>
  withFixtureHome(fixture, async (home) => {
    const location = await locateFound(adapter, fixture.environment(home))
    const before = await withReader(adapter, location, async (reader) => reader.listUnits())
    const [changed] = before
    assert.ok(changed !== undefined, 'the fixture set lists no unit')
    await fixture.change(home, changed.locator)
    const after = await withReader(adapter, location, async (reader) => reader.listUnits())
    assert.deepEqual(
      after.map((unit) => ({
        locator: unit.locator,
        isChanged: unit.fingerprint !== before.find((old) => old.locator === unit.locator)?.fingerprint,
      })),
      before.map((unit) => ({ locator: unit.locator, isChanged: unit.locator === changed.locator }))
    )
  })

const unitGoneCase: TCaseRun = async (adapter, fixture) =>
  withFixtureHome(fixture, async (home) => {
    const location = await locateFound(adapter, fixture.environment(home))
    await withReader(adapter, location, async (reader) => {
      const [gone] = await reader.listUnits()
      assert.ok(gone !== undefined, 'the fixture set lists no unit')
      await fixture.remove(home, gone.locator)
      await assert.rejects(reader.importUnit(gone), (error: unknown) =>
        isErrnoCode(error, ADAPTER_ERROR_CODES.ADAPTER_UNIT_GONE)
      )
    })
  })

const validOutputCase: TCaseRun = async (adapter, fixture) =>
  withFixtureHome(fixture, async (home) => {
    const imports = await importHome(adapter, fixture.environment(home))
    const problems = byLocator(imports, ({ imported }) => validateImportedUnit(adapter.descriptor, imported))
    assert.deepEqual(
      problems,
      byLocator(imports, () => [])
    )
  })

// Each unit's import serialised for its golden file, compared with that file; rewritten first when updating.
const assertGolden = async (
  fixture: IFixtureSet,
  imports: readonly IListedImport[],
  home: string,
  isUpdating: boolean
): Promise<void> => {
  const actual = byLocator(imports, ({ imported }) => goldenText(imported, home))
  if (isUpdating) {
    await Promise.all(Object.entries(actual).map(async ([locator, text]) => writeGolden(fixture, locator, text)))
  }
  const golden = await Promise.all(
    imports.map(async ({ unit }) => [unit.locator, await readGolden(fixture, unit.locator)])
  )
  assert.deepEqual(actual, Object.fromEntries(golden))
}

const goldenOutputCase: TCaseRun = async (adapter, fixture) =>
  withFixtureHome(fixture, async (home) => {
    await assertGolden(fixture, await importHome(adapter, fixture.environment(home)), home, isUpdatingGolden())
  })

const deterministicCase: TCaseRun = async (adapter, fixture) =>
  withFixtureHome(fixture, async (home) => {
    const location = await locateFound(adapter, fixture.environment(home))
    await withReader(adapter, location, async (reader) => {
      const units = await reader.listUnits()
      const first = await Promise.all(units.map(async (unit) => reader.importUnit(unit)))
      const second = await Promise.all(units.map(async (unit) => reader.importUnit(unit)))
      assert.deepEqual(second, first)
    })
  })

const storesCleanlyCase: TCaseRun = async (adapter, fixture) =>
  withFixtureHome(fixture, async (home) => {
    const imports = await importHome(adapter, fixture.environment(home))
    const warehouse = await createTestWarehouse()
    const store = await WarehouseStore.open(warehouse.path)
    try {
      for (const { unit, imported } of imports) {
        store.writeImportedUnit(imported.sessions, {
          harness: adapter.descriptor.id,
          locator: unit.locator,
          fingerprint: unit.fingerprint,
          parserVersion: adapter.descriptor.parserVersion,
          importedAt: 0,
        })
      }
    } finally {
      store.close()
      await warehouse.remove()
    }
  })

const unknownKeptCase: TCaseRun = async (adapter, fixture) =>
  withFixtureHome(fixture, async (home) => {
    const imports = await importHome(adapter, fixture.environment(home))
    const counts = fixture.units.map(({ locator, unknownRecords }) => {
      const events = (imports.find((listed) => listed.unit.locator === locator)?.imported.sessions ?? []).flatMap(
        (session) => session.events.filter((event) => event.kind === 'unknown')
      )
      return {
        locator,
        held: unknownRecords.map((record) => events.filter((event) => unknownHolds(event.dataJson, record)).length),
      }
    })
    assert.deepEqual(
      counts,
      fixture.units.map(({ locator, unknownRecords }) => ({ locator, held: unknownRecords.map(() => 1) }))
    )
  })

const harnessVersionCase: TCaseRun = async (adapter, fixture) =>
  withFixtureHome(fixture, async (home) => {
    const imports = await importHome(adapter, fixture.environment(home))
    assert.deepEqual(
      byLocator(imports, ({ imported }) => imported.harnessVersion),
      Object.fromEntries(fixture.units.map((unit) => [unit.locator, unit.harnessVersion]))
    )
  })

const commandsCase: TCaseRun = async (adapter, fixture) =>
  withFixtureHome(fixture, async (home) => {
    const env = fixture.environment(home)
    const location = await locateFound(adapter, env)
    const expectations = await readCommandExpectations(fixture, home)
    const recogniser = await adapter.prepareCommands(location, env, projectDirsOf(expectations))
    assert.deepEqual(
      expectations.map(({ prompt }) => recogniser.recognise(prompt)),
      expectations.map(({ expected }) => expected)
    )
  })

const closeCase: TCaseRun = async (adapter, fixture) =>
  withFixtureHome(fixture, async (home) => {
    const location = await locateFound(adapter, fixture.environment(home))
    const controller = new AbortController()
    controller.abort(new Error('stopped by the conformance suite'))
    const reader = await adapter.openSource(location, adapterContext(controller.signal))
    await assert.rejects(reader.listUnits())
    await reader.close()
  })

const noHarnessIdLeakCase: TCaseRun = async (adapter, fixture) =>
  withFixtureHome(fixture, async (home) => {
    const imports = await importHome(adapter, fixture.environment(home))
    assert.deepEqual(
      byLocator(imports, ({ imported }) => leakingFields(imported.sessions, adapter.descriptor.id, 'sessions')),
      byLocator(imports, () => [])
    )
  })

const expectedLocate = (variant: ILocateVariant, home: string): Record<string, unknown> => {
  const { expected } = variant
  if (expected.kind === 'found') {
    return { kind: 'found', root: join(home, expected.root) }
  }
  return { kind: 'not-found', lookedAt: expected.lookedAt === null ? null : join(home, expected.lookedAt) }
}

const locateVariantCase =
  (variant: ILocateVariant): TCaseRun =>
  async (adapter) =>
    withEmptyHome(async (home) => {
      await variant.arrange(home)
      const result = await adapter.locate(variant.environment(home))
      const answered =
        result.kind === 'found'
          ? { kind: result.kind, root: result.location.root }
          : { kind: result.kind, lookedAt: result.lookedAt }
      assert.deepEqual(answered, expectedLocate(variant, home))
    })

// Every variant in its own home; a failure names each variant that broke, with its difference.
const locateVariantsCase: TCaseRun = async (adapter, fixture, fixtures) => {
  const results = await Promise.allSettled(
    fixture.locateVariants.map(async (variant) => locateVariantCase(variant)(adapter, fixture, fixtures))
  )
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected' ? [`${fixture.locateVariants[index]?.name ?? ''}: ${String(result.reason)}`] : []
  )
  assert.deepEqual(failures, [])
}

const liveDatabaseCase =
  (prepareLive: (home: string) => Promise<() => void>): TCaseRun =>
  async (adapter, fixture) =>
    withLiveHome(fixture, prepareLive, async (home) => {
      const location = await locateFound(adapter, fixture.environment(home))
      assert.equal(location.kind, 'file', 'a live database case needs a location that is the database file')
      const before = await hashFile(location.root)
      const imports = await withReader(adapter, location, importEvery)
      assert.equal(await hashFile(location.root), before, 'the main database file changed')
      await assertGolden(fixture, imports, home, false)
    })

// Mode 000 on every path the adapter must never read, created with its directories when absent.
const lockNeverRead = async (fixture: IFixtureSet, home: string): Promise<void> => {
  await Promise.all(
    fixture.neverRead.map(async (path) => {
      const absolute = join(home, path)
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, '', { flag: 'a' })
      await chmod(absolute, 0o000)
    })
  )
}

const readScopeCase: TCaseRun = async (adapter, fixture) =>
  withFixtureHome(fixture, async (home) => {
    await lockNeverRead(fixture, home)
    const env = fixture.environment(home)
    const location = await locateFound(adapter, env)
    const imports = await withReader(adapter, location, importEvery)
    await adapter.prepareCommands(location, env, projectDirsOf(await readCommandExpectations(fixture, home)))
    await assertGolden(fixture, imports, home, false)
  })

const skippedCase: TCaseRun = async () => Promise.resolve()

const isRoot = (): boolean => process.getuid?.() === 0

// The cases that only some fixture sets have or that the process cannot always run, numbered 18 to 20.
const scopeCases = (fixture: IFixtureSet): (readonly [string, TCaseRun])[] => [
  ['locate variants', locateVariantsCase],
  ...(fixture.prepareLive === undefined
    ? []
    : [['read-only on a live database', liveDatabaseCase(fixture.prepareLive)] as const]),
  isRoot()
    ? ['reads only what is listed (skipped: running as root, which permissions do not stop)', skippedCase]
    : ['reads only what is listed', readScopeCase],
]

// In the order of the specification's numbers, 1 to 17; number 15 belonged to the removed instruction sources.
const CASES: readonly (readonly [string, TCaseRun])[] = [
  ['descriptor', descriptorCase],
  ['locate found', locateFoundCase],
  ['locate absent', locateAbsentCase],
  ['read-only', readOnlyCase],
  ['listing', listingCase],
  ['fingerprint change', fingerprintChangeCase],
  ['unit gone', unitGoneCase],
  ['valid output', validOutputCase],
  ['golden output', goldenOutputCase],
  ['deterministic', deterministicCase],
  ['stores cleanly', storesCleanlyCase],
  ['unknown kept', unknownKeptCase],
  ['harness version', harnessVersionCase],
  ['commands', commandsCase],
  ['close', closeCase],
  ['no harness id leak', noHarnessIdLeakCase],
]

// The cases every adapter must pass on each of its fixture sets, as plain cases its test file registers one test each.
export const conformanceCases = (
  adapter: IHarnessAdapter,
  fixtures: readonly IFixtureSet[]
): readonly IConformanceCase[] =>
  fixtures.flatMap((fixture) =>
    [...CASES, ...scopeCases(fixture)].map(([name, run]) => ({
      name: `${fixture.harnessVersion}: ${name}`,
      run: async () => run(adapter, fixture, fixtures),
    }))
  )
