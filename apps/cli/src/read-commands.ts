import { createEngine, REPORT_NAMES_ALL, type IReadOperations, type ISessionFilter } from '@log-book/engine'
import { resolveWarehousePath, WarehouseStore } from '@log-book/warehouse'
import { exitCodeOf } from './errors.js'
import { ADAPTERS } from './grammar.js'
import { integerOf, textOf, type OptionValues } from './option-values.js'
import type { CommandRunner } from './run-cli.js'

// The engine's read surface over the warehouse at that path.
export type ReadSurface = (warehousePath: string) => IReadOperations

const line = (text: string): string => `${text}\n`

const positionalOf = (positionals: readonly string[], name: string): string => {
  const [value] = positionals
  if (value === undefined) {
    throw new TypeError(`The parser let the command through without its <${name}>`)
  }
  return value
}

// The start of a local calendar day, as today's `day` helper reads `--since`.
const localDayStart = (day: string): number => Date.parse(`${day}T00:00:00`)

const sessionFilter = (values: OptionValues): ISessionFilter => {
  const since = textOf(values, 'since')
  const filter: ISessionFilter = {}
  for (const name of ['harness', 'origin', 'project', 'goal', 'outcome'] as const) {
    const value = textOf(values, name)
    if (value !== undefined) {
      filter[name] = value
    }
  }
  if (since !== undefined) {
    filter.since = localDayStart(since)
  }
  const limit = integerOf(values, 'limit')
  return limit === undefined ? filter : { ...filter, limit }
}

// The values --harness accepts: the id and the filter alias of every harness row, once each, in the rows' order. A
// harness whose adapter is gone keeps its row, so the command accepts what the web app's `harness:` filter accepts.
const harnessOptionValues = async (warehousePath: string): Promise<string[]> => {
  const reader = await WarehouseStore.openReadOnly(warehousePath)
  try {
    const rows = reader.all<{ id: string; alias: string }>(
      'SELECT id, filter_alias AS alias FROM harness ORDER BY rowid'
    )
    return [...new Set(rows.flatMap(({ id, alias }) => [id, alias]))]
  } finally {
    reader.close()
  }
}

const engineRead: ReadSurface = (warehousePath) => createEngine({ adapters: ADAPTERS, warehousePath }).read

// `logbook sessions`, `search`, `tree`, `timeline`, `report` and `sql`: each prints the engine's markdown on stdout.
// They open the warehouse read-only and take no lock; the engine's errors end them through the error line.
export const createReadRunners = (readOf: ReadSurface = engineRead): Readonly<Record<string, CommandRunner>> => {
  const printing =
    (
      answer: (read: IReadOperations, values: OptionValues, positionals: readonly string[]) => Promise<string>
    ): CommandRunner =>
    async ({ values, positionals, io }) => {
      io.stdout(line(await answer(readOf(resolveWarehousePath()), values, positionals)))
      return exitCodeOf('success')
    }
  const sessions = printing(async (read, values) => read.sessions(sessionFilter(values)))
  return {
    sessions: async (context) => {
      const harness = textOf(context.values, 'harness')
      if (harness !== undefined) {
        const accepted = await harnessOptionValues(resolveWarehousePath())
        if (!accepted.includes(harness)) {
          context.io.stderr(line(`--harness must be one of: ${accepted.join(', ')}; got ${harness}`))
          return exitCodeOf('usage error')
        }
      }
      return sessions(context)
    },
    search: printing(async (read, values, positionals) => {
      const limit = integerOf(values, 'limit')
      return read.search(positionalOf(positionals, 'query'), limit === undefined ? {} : { limit })
    }),
    tree: printing(async (read, values, positionals) =>
      read.tree(positionalOf(positionals, 'session'), { isFromRoot: values.root === true })
    ),
    timeline: printing(async (read, _values, positionals) => read.timeline(positionalOf(positionals, 'session'))),
    report: printing(async (read, values, positionals) => {
      const maxRows = integerOf(values, 'max-rows')
      return read.report(positionals[0] ?? REPORT_NAMES_ALL, maxRows === undefined ? {} : { maxRows })
    }),
    sql: printing(async (read, values, positionals) => {
      const maxRows = integerOf(values, 'max-rows')
      return read.sql(positionalOf(positionals, 'query'), maxRows === undefined ? {} : { maxRows })
    }),
  }
}
