import type { IAdapterEnvironment, IHarnessAdapter, IHarnessDescriptor, LocateResult } from '@log-book/adapter-api'
import { tildePath } from './format.js'

// What one adapter's locate answered, or the defect it threw.
export interface IDiscovered {
  readonly descriptor: IHarnessDescriptor
  readonly answer: LocateResult | { readonly kind: 'threw'; readonly message: string }
}

// The width of the name column: the host's start pads to 13 characters, doctor's report to 12.
export type ColumnWidth = 13 | 12

const columnOf = (label: string, width: ColumnWidth): string => `${label.padEnd(width - 1)} `

// Every adapter's locate, in registration order. A throw is an adapter defect, reported on its line and never
// stopping the others.
export const discoverAdapters = async (
  adapters: readonly IHarnessAdapter[],
  env: IAdapterEnvironment
): Promise<IDiscovered[]> =>
  Promise.all(
    adapters.map(async (adapter): Promise<IDiscovered> => {
      try {
        return { descriptor: adapter.descriptor, answer: await adapter.locate(env) }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        return { descriptor: adapter.descriptor, answer: { kind: 'threw', message } }
      }
    })
  )

// The variable that left the harness without a path: the first of its location variables that is set and not empty.
const setVariable = (descriptor: IHarnessDescriptor, env: IAdapterEnvironment): string | null => {
  const name = descriptor.locationVariables.find((variable) => (env.variables[variable] ?? '') !== '')
  return name === undefined ? null : `${name} is ${String(env.variables[name])}`
}

const notFoundText = (descriptor: IHarnessDescriptor, lookedAt: string | null, env: IAdapterEnvironment): string => {
  if (lookedAt !== null) {
    const [variable] = descriptor.locationVariables
    const elsewhere = variable === undefined ? '' : `; set ${variable} if ${descriptor.name} keeps its data elsewhere`
    return `not on this machine (no ${tildePath(lookedAt, env.homeDir)}${elsewhere})`
  }
  const set = setVariable(descriptor, env)
  return set === null
    ? 'not on this machine'
    : `not on this machine (${set}, so ${descriptor.name} keeps no history on disk)`
}

const answerText = ({ descriptor, answer }: IDiscovered, env: IAdapterEnvironment): string => {
  if (answer.kind === 'found') {
    return `found at ${answer.location.describe}`
  }
  if (answer.kind === 'threw') {
    return `not checked, an adapter defect: ${answer.message}`
  }
  return notFoundText(descriptor, answer.lookedAt, env)
}

const listed = (names: readonly string[]): string =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`

const ANY_OF: Readonly<Record<number, string>> = { 1: 'it', 2: 'either' }

// When no adapter found anything: the host still starts, since the user may install an agent next.
const noAgentParagraph = (names: readonly string[]): string =>
  `No agent data found yet. Log Book reads what ${listed(names)} keep${names.length === 1 ? 's' : ''} on this ` +
  `machine; it will pick ${names.length === 1 ? 'it' : 'them'} up on the next sync once ` +
  `${ANY_OF[names.length] ?? 'any of them'} has run here.`

// One line per registered adapter, every word from its answer and its descriptor; then, when none found anything, a
// blank line and the paragraph saying so.
export const discoveryLines = (
  discovered: readonly IDiscovered[],
  width: ColumnWidth,
  env: IAdapterEnvironment
): string[] => {
  const lines = discovered.map((found) => columnOf(found.descriptor.name, width) + answerText(found, env))
  if (discovered.some(({ answer }) => answer.kind === 'found')) {
    return lines
  }
  return [...lines, '', noAgentParagraph(discovered.map(({ descriptor }) => descriptor.name))]
}

// What opening the warehouse did: created it, migrated it, or found it at this build's schema.
export const warehouseLine = (
  opened: { path: string; previousVersion: number; version: number },
  width: ColumnWidth,
  home: string
): string => {
  const { previousVersion, version } = opened
  const head = `${columnOf('Warehouse', width)}${tildePath(opened.path, home)}`
  if (previousVersion === 0) {
    return `${head}, created at schema ${String(version)}`
  }
  if (previousVersion < version) {
    return `${head}, migrated from schema ${String(previousVersion)} to ${String(version)}`
  }
  return `${head}, schema ${String(version)}`
}
