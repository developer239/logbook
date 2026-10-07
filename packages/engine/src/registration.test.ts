import { ADAPTER_ERROR_CODES, type IHarnessAdapter, type IHarnessDescriptor } from '@log-book/adapter-api'
import { inventedAdapter } from '@log-book/adapter-api/testing'
import { LogBookError } from '@log-book/core'
import { describe, expect, it } from 'vitest'
import { createEngine } from './engine.js'

const WAREHOUSE = '/tmp/logbook-engine-test/warehouse.db'

const adapterWith = (descriptor: Partial<IHarnessDescriptor>): IHarnessAdapter => {
  const adapter = inventedAdapter()
  return { ...adapter, descriptor: { ...adapter.descriptor, ...descriptor } }
}

const refusal = (adapters: readonly IHarnessAdapter[]): unknown => {
  try {
    createEngine({ adapters, warehousePath: WAREHOUSE })
    return null
  } catch (error: unknown) {
    return error instanceof LogBookError ? { code: error.code, message: error.message } : error
  }
}

const invalid = (message: string): unknown => ({ code: ADAPTER_ERROR_CODES.ADAPTER_REGISTRATION_INVALID, message })

describe('createEngine registration', () => {
  const { id } = inventedAdapter().descriptor

  it.each<[string, Partial<IHarnessDescriptor>, string]>([
    ['an empty name', { name: '' }, `The adapter ${id} cannot be registered: its name is empty.`],
    [
      'an empty default agent',
      { defaultAgent: '' },
      `The adapter ${id} cannot be registered: its default agent is empty.`,
    ],
    [
      'a filter alias of two words',
      { filterAlias: 'two words' },
      `The adapter ${id} cannot be registered: its filter alias is not one lowercase word.`,
    ],
    [
      'an upper-case filter alias',
      { filterAlias: 'Invented' },
      `The adapter ${id} cannot be registered: its filter alias is not one lowercase word.`,
    ],
    [
      'a parser version of zero',
      { parserVersion: 0 },
      `The adapter ${id} cannot be registered: its parser version is not a positive integer.`,
    ],
    [
      'a fractional parser version',
      { parserVersion: 1.5 },
      `The adapter ${id} cannot be registered: its parser version is not a positive integer.`,
    ],
    [
      'no tested version',
      { testedVersions: [] },
      `The adapter ${id} cannot be registered: its tested versions are not a non-empty list of major.minor versions.`,
    ],
    [
      'a tested version that is not major.minor',
      { testedVersions: ['1.0.3'] },
      `The adapter ${id} cannot be registered: its tested versions are not a non-empty list of major.minor versions.`,
    ],
    [
      'location variables without what each changes',
      { locationVariables: ['EXAMPLE_HOME'] as unknown as IHarnessDescriptor['locationVariables'] },
      `The adapter ${id} cannot be registered: its location variables are not a list of names with what each changes.`,
    ],
  ])('refuses %s, naming the adapter and the rule', (_rule, descriptor, message) => {
    // Act
    const error = refusal([adapterWith(descriptor)])

    // Assert
    expect(error).toStrictEqual(invalid(message))
  })

  it.each([['Invented-Harness'], ['invented_harness'], ['-invented'], ['invented--harness'], ['']])(
    'refuses the id %j, naming the adapter by its position',
    (badId) => {
      // Act
      const error = refusal([inventedAdapter(), adapterWith({ id: badId, filterAlias: 'second' })])

      // Assert
      expect(error).toStrictEqual(invalid('The adapter at position 2 cannot be registered: its id is not kebab-case.'))
    }
  )

  it('refuses two adapters with the same id', () => {
    // Act
    const error = refusal([inventedAdapter(), adapterWith({ filterAlias: 'second' })])

    // Assert
    expect(error).toStrictEqual(
      invalid(`The adapter at position 2 cannot be registered: its id ${id} is already registered.`)
    )
  })

  it('refuses two adapters with the same filter alias', () => {
    // Act
    const error = refusal([inventedAdapter(), adapterWith({ id: 'second-harness' })])

    // Assert
    expect(error).toStrictEqual(
      invalid(
        `The adapter second-harness cannot be registered: its filter alias ${inventedAdapter().descriptor.filterAlias} is already registered.`
      )
    )
  })

  it('returns an engine for two adapters with different ids and aliases', () => {
    // Arrange
    const adapters = [inventedAdapter(), adapterWith({ id: 'second-harness', filterAlias: 'second' })]

    // Act
    const engine = createEngine({ adapters, warehousePath: WAREHOUSE })

    // Assert
    expect({ ids: engine.adapters.map((adapter) => adapter.descriptor.id), path: engine.warehousePath }).toStrictEqual({
      ids: [id, 'second-harness'],
      path: WAREHOUSE,
    })
  })
})
