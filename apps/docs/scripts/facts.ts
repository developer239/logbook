import type { ICommandSpec, PACKAGE } from '@log-book/cli/grammar'

const FACT_NAMES = ['defaultPort', 'defaultAddress', 'defaultModel', 'nodeFloor'] as const
type FactName = (typeof FACT_NAMES)[number]
export type Facts = Readonly<Record<FactName, string>>

// What the pages show of the CLI: its package, binary and dist-tags, and the values a page names inline.
export interface ICliFacts {
  package: typeof PACKAGE
  facts: Facts
}

const NODE_FLOOR = /^>=(?<floor>\d+(?:\.\d+)?)$/u

const defaultOf = (commands: readonly ICommandSpec[], words: string, option: string): string => {
  const value = commands
    .find((command) => command.words.join(' ') === words)
    ?.options.find((candidate) => candidate.name === option)?.default
  if (value === undefined || value === null || typeof value === 'boolean') {
    throw new Error(`logbook ${words} has no default for --${option}`)
  }
  return String(value)
}

// The values from the command table, and the Node floor from the CLI's engines.node, such as >=24.15.
export const factsOf = (commands: readonly ICommandSpec[], engines: string): Facts => {
  const floor = NODE_FLOOR.exec(engines)?.groups?.floor
  if (floor === undefined) {
    throw new Error(`The CLI's engines.node ${engines} names no floor such as >=24.15`)
  }
  const port = defaultOf(commands, 'start', 'port')
  return {
    defaultPort: port,
    // The page's whole address, for a page that shows it as code: Markdown turns a bare address into a link.
    defaultAddress: `http://127.0.0.1:${port}`,
    defaultModel: defaultOf(commands, 'labels update', 'model'),
    nodeFloor: floor,
  }
}

const isFactName = (name: string): name is FactName => FACT_NAMES.some((factName) => factName === name)

// One fact by its name; an unknown name stops the build, naming it and the page that asked for it.
export const factOf = (facts: Facts, name: string, page: string): string => {
  if (!isFactName(name)) {
    throw new Error(
      `${page} asks for the fact ${name}, which the site does not hold (it holds ${FACT_NAMES.join(', ')})`
    )
  }
  return facts[name]
}
