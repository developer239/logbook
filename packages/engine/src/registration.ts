import { ADAPTER_ERROR_CODES, type IHarnessAdapter, type IHarnessDescriptor } from '@log-book/adapter-api'
import { LogBookError } from '@log-book/core'

const ADAPTER_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const FILTER_ALIAS = /^[a-z]+$/u
const TESTED_VERSION = /^\d+\.\d+$/u

// The rule a descriptor breaks, or null.
type TDescriptorRule = (descriptor: IHarnessDescriptor) => string | null

const RULES: readonly TDescriptorRule[] = [
  ({ name }) => (typeof name === 'string' && name !== '' ? null : 'its name is empty'),
  ({ defaultAgent }) => (typeof defaultAgent === 'string' && defaultAgent !== '' ? null : 'its default agent is empty'),
  ({ filterAlias }) =>
    typeof filterAlias === 'string' && FILTER_ALIAS.test(filterAlias)
      ? null
      : 'its filter alias is not one lowercase word',
  ({ parserVersion }) =>
    Number.isInteger(parserVersion) && parserVersion > 0 ? null : 'its parser version is not a positive integer',
  ({ testedVersions }) =>
    Array.isArray(testedVersions) &&
    testedVersions.length > 0 &&
    testedVersions.every((version) => typeof version === 'string' && TESTED_VERSION.test(version))
      ? null
      : 'its tested versions are not a non-empty list of major.minor versions',
  ({ locationVariables }) =>
    Array.isArray(locationVariables) && locationVariables.every((variable) => typeof variable === 'string')
      ? null
      : 'its location variables are not an array of strings',
]

const invalid = (who: string, rule: string): LogBookError =>
  new LogBookError(
    `The adapter ${who} cannot be registered: ${rule}.`,
    ADAPTER_ERROR_CODES.ADAPTER_REGISTRATION_INVALID
  )

// Checks each adapter's descriptor once, in list order, and throws for the first broken rule, naming the adapter by
// its id, or by its position in the list when the id itself is the problem.
export const checkRegistrations = (adapters: readonly IHarnessAdapter[]): void => {
  const ids = new Set<string>()
  const aliases = new Set<string>()
  for (const [index, { descriptor }] of adapters.entries()) {
    const position = `at position ${String(index + 1)}`
    if (typeof descriptor.id !== 'string' || !ADAPTER_ID.test(descriptor.id)) {
      throw invalid(position, 'its id is not kebab-case')
    }
    if (ids.has(descriptor.id)) {
      throw invalid(position, `its id ${descriptor.id} is already registered`)
    }
    const broken = RULES.map((rule) => rule(descriptor)).find((rule) => rule !== null)
    if (broken !== undefined) {
      throw invalid(descriptor.id, broken)
    }
    if (aliases.has(descriptor.filterAlias)) {
      throw invalid(descriptor.id, `its filter alias ${descriptor.filterAlias} is already registered`)
    }
    ids.add(descriptor.id)
    aliases.add(descriptor.filterAlias)
  }
}
