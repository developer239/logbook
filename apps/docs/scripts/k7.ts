import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { ICommandSpec, IExitCode, ParsedCommandLine } from '@log-book/cli/grammar'
import { commandSlug } from './reference.js'

export interface IFinding {
  rule: string
  // Repository-relative.
  file: string
  line: number
  message: string
}

export interface IK7Inputs {
  // The documentation package's directory, which holds src and scripts.
  docs: string
  // Findings name files relative to it.
  repository: string
  commands: readonly ICommandSpec[]
  exitCodes: readonly IExitCode[]
  whatToDo: Readonly<Record<number, string>>
  parse: (argv: readonly string[]) => ParsedCommandLine
  // The CLI's binary and package name, as a command line in a page starts with them.
  binary: string
  packageName: string
}

const RULE = 'K7'
const FENCE = /^\s*(?<fence>`{3,}|~{3,})/u
// Leading `NAME=value` assignments, the value bare or quoted.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/u
const COMMENT = / #(?: .*)?$/u
const WHITESPACE = /\s/u
const GENERATED = `.generated${sep}`
const EXAMPLES = join('src', 'reference', 'examples')
const WHAT_TO_DO = join('scripts', 'what-to-do.ts')

// One line per finding: `<rule> <file>:<line> <message>`.
export const findingLine = ({ rule, file, line, message }: IFinding): string =>
  `${rule} ${file}:${String(line)} ${message}`

interface IWords {
  words: string[]
  word: string | null
  quote: string | null
  isEscaped: boolean
}

const QUOTES = new Set(['"', "'"])

const appended = (state: IWords, character: string): IWords => ({
  ...state,
  word: `${state.word ?? ''}${character}`,
  isEscaped: false,
})

const readUnquoted = (state: IWords, character: string): IWords => {
  if (QUOTES.has(character)) {
    return { ...state, quote: character, word: state.word ?? '' }
  }
  if (character === '\\') {
    return { ...state, isEscaped: true }
  }
  if (!WHITESPACE.test(character)) {
    return appended(state, character)
  }
  return state.word === null ? state : { ...state, words: [...state.words, state.word], word: null }
}

// One character of a shell line: quotes group, and a backslash outside single quotes keeps the next character.
const readCharacter = (state: IWords, character: string): IWords => {
  if (state.isEscaped) {
    return appended(state, character)
  }
  if (state.quote === null) {
    return readUnquoted(state, character)
  }
  if (character === state.quote) {
    return { ...state, quote: null }
  }
  return character === '\\' && state.quote === '"' ? { ...state, isEscaped: true } : appended(state, character)
}

// A shell line's words.
const shellWords = (line: string): string[] => {
  const { words, word } = [...line].reduce(readCharacter, { words: [], word: null, quote: null, isEscaped: false })
  return word === null ? words : [...words, word]
}

const withoutAssignments = (line: string): string => {
  const match = ASSIGNMENT.exec(line)
  return match === null ? line : withoutAssignments(line.slice(match[0].length))
}

// The arguments a code block line gives logbook, or null for a line that does not run it.
const argumentsOf = (line: string, binary: string, packageName: string): string[] | null => {
  const [first, second, ...rest] = shellWords(withoutAssignments(line.trim()).replace(COMMENT, ''))
  if (first === binary) {
    return second === undefined ? [] : [second, ...rest]
  }
  const isPackage = second === packageName || second?.startsWith(`${packageName}@`) === true
  return first === 'npx' && isPackage ? rest : null
}

// The lines inside fenced code blocks, with their line numbers.
export const codeLines = (text: string): { line: number; text: string }[] => {
  let fence: string | null = null
  return text.split('\n').flatMap((line, index) => {
    const opening = FENCE.exec(line)?.groups?.fence
    if (fence === null) {
      fence = opening ?? null
      return []
    }
    if (opening !== undefined && opening.startsWith(fence) && line.trim() === opening) {
      fence = null
      return []
    }
    return [{ line: index + 1, text: line }]
  })
}

// Every hand-written page under src, relative to it, in order.
export const pagesOf = async (docs: string): Promise<string[]> =>
  (await readdir(join(docs, 'src'), { recursive: true }))
    .filter((path) => path.endsWith('.md') && !path.startsWith(GENERATED))
    .toSorted()

// Every logbook line of a code block that the parser refuses.
const commandLineFindings = async (inputs: IK7Inputs): Promise<IFinding[]> => {
  const pages = await pagesOf(inputs.docs)
  const findings = await Promise.all(
    pages.map(async (page) => {
      const path = join(inputs.docs, 'src', page)
      const lines = codeLines(await readFile(path, 'utf8'))
      return lines.flatMap(({ line, text }) => {
        const argv = argumentsOf(text, inputs.binary, inputs.packageName)
        const parsed = argv === null ? null : inputs.parse(argv)
        return parsed?.kind === 'usage-error'
          ? [{ rule: RULE, file: relative(inputs.repository, path), line, message: parsed.line }]
          : []
      })
    })
  )
  return findings.flat()
}

// A command without its examples file, or an examples file for no command of the table.
const examplesFindings = async (inputs: IK7Inputs): Promise<IFinding[]> => {
  const directory = join(inputs.docs, EXAMPLES)
  const files = new Set((await readdir(directory)).filter((file) => file.endsWith('.md')))
  const slugs = new Set(inputs.commands.map(commandSlug))
  const at = (file: string): string => relative(inputs.repository, join(directory, file))
  return [
    ...inputs.commands
      .filter((command) => !files.has(`${commandSlug(command)}.md`))
      .map((command) => ({
        rule: RULE,
        file: at(`${commandSlug(command)}.md`),
        line: 1,
        message: `logbook ${command.words.join(' ')} has no examples file`,
      })),
    ...[...files]
      .filter((file) => !slugs.has(file.replace(/\.md$/u, '')))
      .toSorted()
      .map((file) => ({
        rule: RULE,
        file: at(file),
        line: 1,
        message: `${file} gives examples of ${file.replace(/\.md$/u, '').replaceAll('-', ' ')}, which is no command of the table`,
      })),
  ]
}

// The exit code page's written "what to do": one for every code of the table, and none for another code.
const whatToDoFindings = (inputs: IK7Inputs): IFinding[] => {
  const file = relative(inputs.repository, join(inputs.docs, WHAT_TO_DO))
  const codes = new Set(inputs.exitCodes.map((exitCode) => exitCode.code))
  return [
    ...inputs.exitCodes
      .filter((exitCode) => inputs.whatToDo[exitCode.code] === undefined)
      .map((exitCode) => ({
        rule: RULE,
        file,
        line: 1,
        message: `exit code ${String(exitCode.code)} (${exitCode.name}) has no written what to do`,
      })),
    ...Object.keys(inputs.whatToDo)
      .filter((code) => !codes.has(Number(code)))
      .map((code) => ({
        rule: RULE,
        file,
        line: 1,
        message: `what to do is written for exit code ${code}, which the table does not hold`,
      })),
  ]
}

// K7: every hand-written logbook line parses, every command has its examples and only those, and every exit code
// has its written what to do and only those.
export const checkK7 = async (inputs: IK7Inputs): Promise<IFinding[]> => [
  ...(await commandLineFindings(inputs)),
  ...(await examplesFindings(inputs)),
  ...whatToDoFindings(inputs),
]
