import { ADAPTERS } from './adapters.js'

const LOG_BOOK = 'Log Book'

export interface IVariableEffect {
  // Log Book, or the display name of the adapter that reads the variable.
  by: string
  changes: string
}

export interface IEnvironmentVariable {
  name: string
  effects: readonly IVariableEffect[]
  // Null for an internal variable.
  default: string | null
  // Set by a host for its children, never by a user.
  isInternal: boolean
}

const own = (name: string, changes: string, defaultValue: string): IEnvironmentVariable => ({
  name,
  effects: [{ by: LOG_BOOK, changes }],
  default: defaultValue,
  isInternal: false,
})

const LOG_BOOK_VARIABLES: readonly IEnvironmentVariable[] = [
  own(
    'LOGBOOK_DB',
    'The warehouse file, an absolute path; its lock and host files move with it',
    '$XDG_DATA_HOME/log-book/warehouse.db, else ~/.local/share/log-book/warehouse.db'
  ),
  own('XDG_DATA_HOME', "Log Book's data directory (log-book inside it)", '~/.local/share'),
  own('LOGBOOK_DEBUG', "1 prints a stack trace before an error's line", 'unset'),
  own('CLAUDE_BIN', 'The claude binary labelling runs', 'claude on the PATH'),
]

const INTERNAL_VARIABLES: readonly IEnvironmentVariable[] = ['LOGBOOK_CLI', 'LOGBOOK_HOST_VERSION'].map((name) => ({
  name,
  effects: [{ by: LOG_BOOK, changes: 'Set by a host for its children, never by a user' }],
  default: null,
  isInternal: true,
}))

// Each adapter's location variables join the table from its descriptor: a variable Log Book reads too keeps one row,
// with the adapter's effect added to it.
const withAdapterVariables = (variables: readonly IEnvironmentVariable[]): IEnvironmentVariable[] =>
  ADAPTERS.reduce<IEnvironmentVariable[]>(
    (rows, { descriptor }) => {
      const effect = { by: descriptor.name, changes: `Where ${descriptor.name} keeps its data, read as it reads it` }
      return descriptor.locationVariables.reduce<IEnvironmentVariable[]>((current, name) => {
        const existing = current.find((row) => row.name === name)
        if (existing !== undefined) {
          return current.map((row) => (row === existing ? { ...row, effects: [...row.effects, effect] } : row))
        }
        return [...current, { name, effects: [effect], default: `${descriptor.name}'s own default`, isInternal: false }]
      }, rows)
    },
    [...variables]
  )

// Every variable a user may set, with what it changes and its default, then the internal ones.
export const ENVIRONMENT: readonly IEnvironmentVariable[] = [
  ...withAdapterVariables(LOG_BOOK_VARIABLES),
  ...INTERNAL_VARIABLES,
]
