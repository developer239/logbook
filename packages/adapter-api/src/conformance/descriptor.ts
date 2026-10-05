import type { IHarnessDescriptor } from '../contract.js'

const ADAPTER_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const FILTER_ALIAS = /^[a-z]+$/u
const TESTED_VERSION = /^\d+\.\d+$/u

const isFilled = (value: string): boolean => value.trim() !== ''

// Every rule a descriptor keeps on its own; uniqueness among registered adapters is the engine's to check.
export const descriptorProblems = (descriptor: IHarnessDescriptor): string[] =>
  [
    [ADAPTER_ID.test(descriptor.id), `id ${descriptor.id} is not kebab-case`],
    [isFilled(descriptor.name), 'name is empty'],
    [isFilled(descriptor.defaultAgent), 'defaultAgent is empty'],
    [
      isFilled(descriptor.unitNoun) && descriptor.unitNoun === descriptor.unitNoun.toLowerCase(),
      'unitNoun is empty or not lowercase',
    ],
    [FILTER_ALIAS.test(descriptor.filterAlias), 'filterAlias is not one lowercase word'],
    [
      Number.isSafeInteger(descriptor.parserVersion) && descriptor.parserVersion > 0,
      'parserVersion is not a positive integer',
    ],
    [descriptor.testedVersions.length > 0, 'testedVersions is empty'],
    [descriptor.testedVersions.every((version) => TESTED_VERSION.test(version)), 'a tested version is not major.minor'],
    [descriptor.locationVariables.every((variable) => isFilled(variable)), 'a location variable is empty'],
  ]
    .filter(([isKept]) => isKept === false)
    .map(([, problem]) => String(problem))
