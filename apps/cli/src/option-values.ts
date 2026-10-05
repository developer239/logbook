import { LABEL_TASK_NAMES, type LabelTaskName } from '@log-book/engine'
import type { OptionValue } from './grammar.js'

// A command's option values as the parser typed them.
export type OptionValues = Readonly<Record<string, OptionValue>>

// A text option's value; the parser has checked its kind, so another type is a bug, not a usage error.
export const textOf = (values: OptionValues, name: string): string | undefined => {
  const value = values[name]
  if (value !== undefined && typeof value !== 'string') {
    throw new TypeError(`--${name} was parsed as ${typeof value}, not as text`)
  }
  return value
}

export const integerOf = (values: OptionValues, name: string): number | undefined => {
  const value = values[name]
  if (value !== undefined && typeof value !== 'number') {
    throw new TypeError(`--${name} was parsed as ${typeof value}, not as a number`)
  }
  return value
}

// An integer option the parser always gives, from its default when the command line leaves it out.
export const requiredIntegerOf = (values: OptionValues, name: string): number => {
  const value = integerOf(values, name)
  if (value === undefined) {
    throw new TypeError(`The parser let the command through without its --${name}`)
  }
  return value
}

// A required text option the parser has made sure is given.
export const requiredTextOf = (values: OptionValues, name: string): string => {
  const value = textOf(values, name)
  if (value === undefined) {
    throw new TypeError(`The parser let the command through without its --${name}`)
  }
  return value
}

// The --task the parser checked against the engine's task names.
export const taskOf = (values: OptionValues): LabelTaskName => {
  const given = requiredTextOf(values, 'task')
  const task = LABEL_TASK_NAMES.find((name) => name === given)
  if (task === undefined) {
    throw new TypeError(`The parser let the command through with --task ${given}`)
  }
  return task
}
