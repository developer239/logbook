import type { ICommandSpec, IEnvironmentVariable, IExitCode, IOptionSpec } from '@log-book/cli/grammar'

// Markdown punctuation and the angle brackets of placeholders such as <session>, which a page would otherwise read as
// emphasis, a table cell's end or an HTML tag.
const MARKDOWN = /[\\`*_[\]<>|{}]/gu
const EXIT_CODES_PAGE = '/reference/exit-codes'
const SCHEMA_PAGE = '/reference/schema'
const EXAMPLES = '../reference/examples'

// Text from the command table as a page shows it, word for word.
export const escaped = (text: string): string => text.replaceAll(MARKDOWN, (character) => `\\${character}`)

const code = (text: string): string => `\`${text}\``

const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`

const table = (headers: readonly string[], rows: readonly (readonly string[])[]): string[] => [
  row(headers),
  row(headers.map(() => '---')),
  ...rows.map(row),
]

// A command's words joined, such as labels-update: its examples file and its anchor.
export const commandSlug = (command: ICommandSpec): string => command.words.join('-')

// An exit code's anchor on its page, such as usage-error.
const exitCodeSlug = (name: string): string => name.replaceAll(' ', '-')

const rangeOf = (option: IOptionSpec): string | null => {
  if (option.min === null) {
    return null
  }
  return option.max === null ? `at least ${String(option.min)}` : `${String(option.min)} to ${String(option.max)}`
}

const valueOf = (option: IOptionSpec): string => {
  const parts = [
    option.placeholder === null ? null : code(option.placeholder),
    rangeOf(option),
    option.isRequired ? 'required' : null,
  ]
  return parts.filter((part) => part !== null).join(', ')
}

// A flag is off unless given, so it shows no default.
const defaultOf = (option: IOptionSpec): string =>
  option.default === null || option.kind === 'flag' ? '' : code(String(option.default))

const optionsTable = (options: readonly IOptionSpec[]): string[] =>
  table(
    ['Option', 'Value', 'Default', 'Help'],
    options.map((option) => [code(`--${option.name}`), valueOf(option), defaultOf(option), escaped(option.help)])
  )

// The values a choice option or a positional accepts, as the table holds them.
const valuesOf = (command: ICommandSpec): string[] => [
  ...command.positionals.flatMap((positional) =>
    positional.values === null
      ? []
      : [`Values of ${code(`<${positional.name}>`)}: ${positional.values.map(code).join(', ')}`]
  ),
  ...command.options.flatMap((option) =>
    option.kind === 'choice' && option.values !== null
      ? [`Values of ${code(`--${option.name}`)}: ${option.values.map(code).join(', ')}`]
      : []
  ),
]

const exitCodesOf = (command: ICommandSpec, exitCodes: readonly IExitCode[]): string =>
  command.exitCodes
    .map((name) => {
      const exitCode = exitCodes.find((candidate) => candidate.name === name)
      if (exitCode === undefined) {
        throw new Error(`logbook ${command.words.join(' ')} raises ${name}, which the exit code table does not hold`)
      }
      return `[${String(exitCode.code)} ${name}](${EXIT_CODES_PAGE}#${exitCodeSlug(name)})`
    })
    .join(', ')

const commandSection = (command: ICommandSpec, exitCodes: readonly IExitCode[]): string[] => [
  `## logbook ${command.words.join(' ')}`,
  '',
  '```sh',
  command.synopsis,
  '```',
  '',
  // The description opens with what the summary says, so the summary, written for `logbook --help`, is left out.
  // Each line of a description is a paragraph of its own, as the terminal shows it on a line of its own.
  ...command.description.split('\n').flatMap((line) => [escaped(line), '']),
  ...(command.tables === null
    ? []
    : [
        `\`logbook ${command.words.join(' ')} --help\` prints the tables too; [Database schema](${SCHEMA_PAGE}) lists them.`,
        '',
      ]),
  ...(command.options.length === 0 ? [] : [...optionsTable(command.options), '']),
  ...valuesOf(command).flatMap((line) => [line, '']),
  `**Writes:** ${command.isWriting ? 'yes' : 'no'}`,
  '',
  `**Exit codes:** ${exitCodesOf(command, exitCodes)}`,
  '',
  `<!--@include: ${EXAMPLES}/${commandSlug(command)}.md-->`,
  '',
]

// One section per command, in the table's order, each followed by its written examples.
export const cliPage = (commands: readonly ICommandSpec[], exitCodes: readonly IExitCode[]): string =>
  commands.flatMap((command) => commandSection(command, exitCodes)).join('\n')

const commandNamed = (commands: readonly ICommandSpec[], words: string): ICommandSpec => {
  const command = commands.find((candidate) => candidate.words.join(' ') === words)
  if (command === undefined) {
    throw new Error(`The command table has no logbook ${words}`)
  }
  return command
}

const optionNamed = (command: ICommandSpec, name: string): IOptionSpec => {
  const option = command.options.find((candidate) => candidate.name === name)
  if (option === undefined) {
    throw new Error(`logbook ${command.words.join(' ')} has no --${name}`)
  }
  return option
}

// The options table of the default command alone.
export const startOptionsPage = (commands: readonly ICommandSpec[]): string =>
  `${optionsTable(commandNamed(commands, 'start').options).join('\n')}\n`

// The --model help line alone, as labels update prints it.
export const modelOptionPage = (commands: readonly ICommandSpec[]): string =>
  `${escaped(optionNamed(commandNamed(commands, 'labels update'), 'model').help)}\n`

// Every code with its written "what to do", which every code must have and no other code may.
export const exitCodesPage = (exitCodes: readonly IExitCode[], whatToDo: Readonly<Record<number, string>>): string => {
  const unknown = Object.keys(whatToDo).filter((key) => !exitCodes.some((exitCode) => String(exitCode.code) === key))
  if (unknown.length > 0) {
    throw new Error(`What to do is written for exit codes the table does not hold: ${unknown.join(', ')}`)
  }
  const rows = exitCodes.map((exitCode) => {
    const advice = whatToDo[exitCode.code]
    if (advice === undefined) {
      throw new Error(`Exit code ${String(exitCode.code)} (${exitCode.name}) has no written "what to do"`)
    }
    return [
      `<span id="${exitCodeSlug(exitCode.name)}">${String(exitCode.code)}</span>`,
      exitCode.name,
      escaped(exitCode.meaning),
      escaped(exitCode.raisedBy),
      escaped(advice),
    ]
  })
  return `${table(['Code', 'Name', 'Meaning', 'Raised by', 'What to do'], rows).join('\n')}\n`
}

// The variables a user may set, each once, with every effect the table gives it.
export const environmentPage = (environment: readonly IEnvironmentVariable[]): string => {
  const rows = environment
    .filter((variable) => !variable.isInternal)
    .map((variable) => [
      code(variable.name),
      variable.effects.map((effect) => `${effect.by}: ${escaped(effect.changes)}`).join('<br>'),
      escaped(variable.default ?? ''),
    ])
  return `${table(['Variable', 'What it changes', 'Default'], rows).join('\n')}\n`
}

// The index of the parenthesis that closes the one at open.
const closingOf = (text: string, open: number): number => {
  let depth = 0
  for (const [index, character] of [...text].entries()) {
    if (index < open) {
      continue
    }
    depth += Number(character === '(') - Number(character === ')')
    if (depth === 0) {
      return index
    }
  }
  return -1
}

// Splits at the commas outside parentheses: `id (a, b), name` is two columns.
const topLevelParts = (text: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (const [index, character] of [...text].entries()) {
    depth += Number(character === '(') - Number(character === ')')
    if (character === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim())
      start = index + 1
    }
  }
  return [...parts, text.slice(start).trim()]
}

const NOTES = /^(?: - (?<notes>.+?))?[;.]$/u

// `table(column notes, ...) - notes;`, the notes optional, as a section: the table's notes, then one row per column.
const tableSection = (line: string): string[] => {
  const open = line.indexOf('(')
  const close = open <= 0 ? -1 : closingOf(line, open)
  const notes = close === -1 ? null : NOTES.exec(line.slice(close + 1))
  if (notes === null) {
    throw new Error(`A table line is not table(columns) - notes: ${line}`)
  }
  const text = notes.groups?.notes
  const columns = topLevelParts(line.slice(open + 1, close)).map((column) => {
    const [name = '', ...words] = column.split(' ')
    const details = words.join(' ')
    // A note wholly in parentheses reads as the cell itself.
    const isWrapped = details.startsWith('(') && closingOf(details, 0) === details.length - 1
    return [code(name), escaped(isWrapped ? details.slice(1, -1) : details)]
  })
  return [
    `## ${line.slice(0, open)}`,
    '',
    ...(text === undefined ? [] : [`${escaped(text.charAt(0).toUpperCase() + text.slice(1))}.`, '']),
    ...table(['Column', 'Notes'], columns),
    '',
  ]
}

// The tables logbook sql --help prints: its first line, the conventions every table follows, then a section a table.
export const schemaPage = (commands: readonly ICommandSpec[]): string => {
  const { tables } = commandNamed(commands, 'sql')
  if (tables === null) {
    throw new Error('logbook sql prints no tables')
  }
  const [conventions = '', ...lines] = tables.split('\n')
  return [escaped(conventions), '', ...lines.flatMap(tableSection)].join('\n')
}
