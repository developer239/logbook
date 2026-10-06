import { parseArgs, type ParseArgsOptionsConfig } from 'node:util'
import { isLabelModelId, LABEL_MODEL_RULE } from '@log-book/core'
import { COMMANDS, type ICommandSpec, type IOptionSpec } from './commands.js'

export type OptionValue = string | number | boolean

export type ParsedCommandLine =
  | {
      kind: 'command'
      // The command's words, such as `labels update`.
      command: string
      // Every option given, and every option with a default, by name.
      values: Readonly<Record<string, OptionValue>>
      positionals: readonly string[]
    }
  // `logbook --help` (command null) or `logbook <command> --help`.
  | { kind: 'help'; command: string | null }
  | { kind: 'version' }
  // The one line the CLI prints before it exits 2.
  | { kind: 'usage-error'; line: string }

type TCommandResult = Extract<ParsedCommandLine, { kind: 'command' }>

interface IOptionToken {
  name: string
  rawName: string
  value: string | undefined
}

interface IGivenArguments {
  positionals: string[]
  given: IOptionToken[]
}

const HELP = new Set(['--help', '-h'])
const VERSION = new Set(['--version', '-v'])
const DAY = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u
const WHOLE_NUMBER = /^-?\d+$/u
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const FEBRUARY = 2
const LEAP_DAYS = 29

class UsageLine extends Error {}

const START = COMMANDS.find((spec) => spec.words[0] === 'start')

// The command the first words name: a bare logbook, or one with only options, is start.
const commandOf = (argv: readonly string[]): { spec: ICommandSpec; rest: readonly string[] } => {
  const [first, second] = argv
  if ((first === undefined || first.startsWith('-')) && START !== undefined) {
    return { spec: START, rest: argv }
  }
  const pair = COMMANDS.find((spec) => spec.words.length === 2 && spec.words[0] === first && spec.words[1] === second)
  if (pair !== undefined) {
    return { spec: pair, rest: argv.slice(2) }
  }
  const single = COMMANDS.find((spec) => spec.words.length === 1 && spec.words[0] === first)
  if (single !== undefined) {
    return { spec: single, rest: argv.slice(1) }
  }
  const isGroup = COMMANDS.some((spec) => spec.words.length === 2 && spec.words[0] === first)
  const name = isGroup && second !== undefined && !second.startsWith('-') ? `${String(first)} ${second}` : first
  throw new UsageLine(`Unknown command: ${String(name)}. Run logbook --help for the commands.`)
}

const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

const isCalendarDay = (value: string): boolean => {
  const groups = DAY.exec(value)?.groups
  if (groups === undefined) {
    return false
  }
  const [year, month, day] = [Number(groups.year), Number(groups.month), Number(groups.day)]
  const days = month === FEBRUARY && isLeapYear(year) ? LEAP_DAYS : (DAYS_IN_MONTH[month - 1] ?? 0)
  return day >= 1 && day <= days
}

const integerOf = (option: IOptionSpec, value: string): number => {
  const parsed = Number(value)
  const isWhole = WHOLE_NUMBER.test(value) && Number.isSafeInteger(parsed)
  const isInRange = isWhole && parsed >= (option.min ?? parsed) && parsed <= (option.max ?? parsed)
  if (isInRange) {
    return parsed
  }
  throw new UsageLine(
    option.max === null
      ? `--${option.name} must be a positive integer, got ${value}`
      : `--${option.name} must be a whole number from ${String(option.min)} to ${String(option.max)}, got ${value}`
  )
}

const choiceOf = (name: string, values: readonly string[], value: string): string => {
  if (!values.includes(value)) {
    throw new UsageLine(`${name} must be one of: ${values.join(', ')}; got ${value}`)
  }
  return value
}

// A value typed and checked as the option's kind says.
const typedValue = (option: IOptionSpec, value: string): OptionValue => {
  if (option.forbidden?.value === value) {
    throw new UsageLine(option.forbidden.line)
  }
  if (option.kind === 'integer') {
    return integerOf(option, value)
  }
  if (option.kind === 'choice') {
    return choiceOf(`--${option.name}`, option.values ?? [], value)
  }
  if (option.kind === 'day' && !isCalendarDay(value)) {
    throw new UsageLine(`--${option.name} must be a date as YYYY-MM-DD, got ${value}`)
  }
  if (option.kind === 'model' && !isLabelModelId(value)) {
    throw new UsageLine(`--${option.name} ${LABEL_MODEL_RULE}, got ${JSON.stringify(value)}`)
  }
  return value
}

// What parseArgs found, before anything is typed: an unknown option, a flag with a value or an option without one
// is refused here, so parsing stays strict while a value may start with `-`.
const tokensOf = (spec: ICommandSpec, rest: readonly string[]): IGivenArguments => {
  const options: ParseArgsOptionsConfig = { help: { type: 'boolean', short: 'h' } }
  for (const option of spec.options) {
    options[option.name] = { type: option.kind === 'flag' ? 'boolean' : 'string' }
  }
  const { tokens } = parseArgs({ args: [...rest], options, strict: false, allowPositionals: true, tokens: true })
  const positionals: string[] = []
  const given: IOptionToken[] = []
  for (const token of tokens) {
    if (token.kind === 'positional') {
      positionals.push(token.value)
    } else if (token.kind === 'option') {
      given.push({ name: token.name, rawName: token.rawName, value: token.value })
    }
  }
  return { positionals, given }
}

const optionValue = (spec: ICommandSpec, token: IOptionToken): [string, OptionValue] => {
  const option = spec.options.find((candidate) => candidate.name === token.name)
  const name = spec.words.join(' ')
  if (option === undefined) {
    throw new UsageLine(
      `Unknown option ${token.rawName} for logbook ${name}. Run logbook ${name} --help for its options.`
    )
  }
  if (option.kind === 'flag') {
    if (token.value !== undefined) {
      throw new UsageLine(`${token.rawName} takes no value.`)
    }
    return [option.name, true]
  }
  if (token.value === undefined) {
    throw new UsageLine(`--${option.name} needs a value.`)
  }
  return [option.name, typedValue(option, token.value)]
}

const checkPositionals = (spec: ICommandSpec, positionals: readonly string[]): void => {
  const name = spec.words.join(' ')
  const [expected] = spec.positionals
  if (expected === undefined) {
    if (positionals.length > 0) {
      throw new UsageLine(`${name} takes no argument.`)
    }
    return
  }
  if (!expected.isRepeated && (positionals.length > 1 || (positionals.length === 0 && expected.isRequired))) {
    throw new UsageLine(`${name} takes one <${expected.name}>.`)
  }
  const [first] = positionals
  if (expected.values !== null && first !== undefined) {
    choiceOf(`<${expected.name}>`, expected.values, first)
  }
}

// Every required option is given, and every option with a default not given takes it.
const withDefaults = (
  spec: ICommandSpec,
  values: Readonly<Record<string, OptionValue>>
): Record<string, OptionValue> => {
  const name = spec.words.join(' ')
  const missing = spec.options.find((option) => option.isRequired && !(option.name in values))
  if (missing !== undefined) {
    throw new UsageLine(`${name} needs --${missing.name} ${String(missing.placeholder)}.`)
  }
  const defaults = spec.options.flatMap((option) =>
    option.default === null || option.name in values ? [] : [[option.name, option.default] as const]
  )
  return { ...values, ...Object.fromEntries(defaults) }
}

// Exactly one of the command's two forms: its positionals, or its option.
const checkForms = (
  spec: ICommandSpec,
  values: Readonly<Record<string, OptionValue>>,
  positionals: readonly string[]
): void => {
  if (spec.forms === null) {
    return
  }
  const hasOption = spec.forms.option in values
  if (hasOption && positionals.length > 0) {
    throw new UsageLine(spec.forms.both)
  }
  if (!hasOption && positionals.length === 0) {
    throw new UsageLine(spec.forms.neither)
  }
}

const commandLine = (argv: readonly string[]): ParsedCommandLine => {
  const { spec, rest } = commandOf(argv)
  const { positionals, given } = tokensOf(spec, rest)
  const command = spec.words.join(' ')
  if (given.some((token) => token.name === 'help')) {
    return { kind: 'help', command }
  }
  const values: Record<string, OptionValue> = Object.fromEntries(given.map((token) => optionValue(spec, token)))
  checkPositionals(spec, positionals)
  checkForms(spec, values, positionals)
  const result: TCommandResult = { kind: 'command', command, values: withDefaults(spec, values), positionals }
  return result
}

// The arguments after `logbook`, decided as far as the command table can decide them: the command, unknown options,
// types, ranges, the engine's vocabularies, required options, positionals, the model rule and each command's own
// forms. What needs the machine (an agent, a session or a project that matches nothing) is the command's to check.
// Pure: it opens no file, reads no environment and starts no process.
export const parseCommandLine = (argv: readonly string[]): ParsedCommandLine => {
  const [only] = argv
  if (argv.length === 1 && only !== undefined && HELP.has(only)) {
    return { kind: 'help', command: null }
  }
  if (argv.length === 1 && only !== undefined && VERSION.has(only)) {
    return { kind: 'version' }
  }
  try {
    return commandLine(argv)
  } catch (error) {
    if (error instanceof UsageLine) {
      return { kind: 'usage-error', line: error.message }
    }
    throw error
  }
}
