import {
  COMMANDS,
  ENVIRONMENT,
  EXIT_CODES,
  PACKAGE,
  type ICommandSpec,
  type IEnvironmentVariable,
  type IOptionSpec,
} from './grammar.js'

const INDENT = '  '
const DETAIL_INDENT = '      '

const usageLine = `Usage: ${PACKAGE.binary} [<command>] [options]`

const commandLines = (command: ICommandSpec): string[] => [
  ...command.synopsis.split('\n').map((line) => `${INDENT}${line}`),
  `${DETAIL_INDENT}${command.summary}`,
]

const variableLines = (variable: IEnvironmentVariable): string[] => [
  `${INDENT}${variable.name}${variable.default === null ? '' : ` (default ${variable.default})`}`,
  ...variable.effects.map((effect) => `${DETAIL_INDENT}${effect.by}: ${effect.changes}`),
]

// `logbook --help`: the usage line, each command's synopsis and summary in table order, and the environment
// variables a user may set with their defaults.
export const renderHelp = (): string =>
  [
    usageLine,
    '',
    'Commands:',
    ...COMMANDS.flatMap(commandLines),
    '',
    'Environment:',
    ...ENVIRONMENT.filter((variable) => !variable.isInternal).flatMap(variableLines),
    '',
    `Run ${PACKAGE.binary} <command> --help for its options and exit codes.`,
  ].join('\n')

const allowedOf = (option: IOptionSpec): string | null => {
  if (option.values !== null) {
    return `One of: ${option.values.join(', ')}.`
  }
  if (option.kind !== 'integer') {
    return null
  }
  return option.max === null
    ? 'A positive integer.'
    : `A whole number from ${String(option.min)} to ${String(option.max)}.`
}

const optionLines = (option: IOptionSpec): string[] => {
  const details = [
    option.isRequired ? 'Required.' : null,
    option.default === null || option.default === false ? null : `Default ${String(option.default)}.`,
    allowedOf(option),
  ].filter((detail) => detail !== null)
  return [
    `${INDENT}--${option.name}${option.placeholder === null ? '' : ` ${option.placeholder}`}`,
    `${DETAIL_INDENT}${option.help}`,
    ...(details.length === 0 ? [] : [`${DETAIL_INDENT}${details.join(' ')}`]),
  ]
}

// `logbook <command> --help`: its synopsis, description, each option with its placeholder, default, allowed values
// and help line, and the exit codes it raises with their names.
export const renderCommandHelp = (command: ICommandSpec): string =>
  [
    `Usage: ${command.synopsis}`,
    '',
    command.description,
    ...(command.tables === null ? [] : ['The tables:', command.tables]),
    '',
    'Options:',
    ...command.options.flatMap(optionLines),
    `${INDENT}--help, -h`,
    `${DETAIL_INDENT}Show this help`,
    '',
    'Exit codes:',
    ...EXIT_CODES.filter((exit) => command.exitCodes.includes(exit.name)).map(
      (exit) => `${INDENT}${String(exit.code)}  ${exit.name}`
    ),
  ].join('\n')
