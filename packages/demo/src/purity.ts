import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isErrnoCode } from '@log-book/core'

// The generator's sources, relative to the package: whatever they compute must follow from the seed alone.
const SCANNED_DIRECTORIES = ['src/plan', 'src/corpus']
const SCANNED_FILES = ['src/random.ts']
const BANNED_MODULES = new Set(['fs', 'os', 'child_process'])

// Each pattern runs on code whose comments and string contents are blanked, so text that only mentions an API is
// clean. A pattern without a name reports its `api` group.
const BANNED_PATTERNS: readonly (readonly [RegExp, string?])[] = [
  [/\bprocess\s*\.\s*env\b/gu, 'process.env'],
  [/\bDate\s*\.\s*now\b/gu, 'Date.now'],
  [/\bDate\s*\.\s*parse\b/gu, 'Date.parse'],
  [/\bMath\s*\.\s*random\b/gu, 'Math.random'],
  [/\.\s*(?<api>[gs]et(?:FullYear|Month|Date|Day|Hours|Minutes|TimezoneOffset))\b/gu],
  [/\.\s*(?<api>to(?:Date|Time|Locale|LocaleDate|LocaleTime)String)\b/gu],
  [/\.\s*toString\s*\(/gu, 'toString'],
  [/\bIntl\b/gu, 'Intl'],
  [/\blocaleCompare\b/gu, 'localeCompare'],
]
const NEW_DATE = /\bnew\s+Date\b/gu
const MODULE_SPECIFIER = /(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\()\s*$/u
// Enough code before a string to hold `import (` or `require (` and the spaces around them.
const SPECIFIER_LOOKBEHIND = 32
const OPENERS = new Set(['(', '[', '{'])
const CLOSERS = new Set([')', ']', '}'])

export interface IPurityFinding {
  // Relative to the package directory.
  file: string
  line: number
  api: string
}

interface IUse {
  offset: number
  api: string
}

interface IStringLiteral {
  offset: number
  value: string
}

interface IMaskedSource {
  code: string
  strings: IStringLiteral[]
}

// Blanks comments and the contents of string and template literals, keeping their quotes, the newlines and every
// offset, and collects each quoted string's value for the import check. Template expressions stay code.
class SourceMasker {
  private readonly source: string
  private readonly code: string[]
  private readonly strings: IStringLiteral[] = []
  private readonly templateDepths: number[] = []
  private braceDepth = 0
  private index = 0

  constructor(source: string) {
    this.source = source
    this.code = [...source]
  }

  public mask(): IMaskedSource {
    while (this.index < this.source.length) {
      this.step()
    }
    return { code: this.code.join(''), strings: this.strings }
  }

  private step(): void {
    const character = this.source[this.index]
    if (this.source.startsWith('//', this.index)) {
      this.skipComment('\n', 0)
    } else if (this.source.startsWith('/*', this.index)) {
      this.skipComment('*/', 2)
    } else if (character === "'" || character === '"') {
      this.skipString(character)
    } else if (character === '`') {
      this.index += 1
      this.skipTemplateText()
    } else {
      this.stepCode(character)
    }
  }

  private stepCode(character: string | undefined): void {
    this.index += 1
    if (character === '{') {
      this.braceDepth += 1
    } else if (character === '}') {
      this.braceDepth -= 1
      if (this.templateDepths.at(-1) === this.braceDepth) {
        this.templateDepths.pop()
        this.skipTemplateText()
      }
    }
  }

  private skipComment(terminator: string, terminatorLength: number): void {
    const end = this.source.indexOf(terminator, this.index + 2)
    const stop = end === -1 ? this.source.length : end + terminatorLength
    this.blank(this.index, stop)
    this.index = stop
  }

  private skipString(quote: string): void {
    const start = this.index + 1
    this.index = start
    while (this.index < this.source.length && this.source[this.index] !== quote && this.source[this.index] !== '\n') {
      this.index += this.source[this.index] === '\\' ? 2 : 1
    }
    this.strings.push({ offset: start - 1, value: this.source.slice(start, this.index) })
    this.blank(start, this.index)
    this.index += 1
  }

  private skipTemplateText(): void {
    const start = this.index
    while (
      this.index < this.source.length &&
      this.source[this.index] !== '`' &&
      !this.source.startsWith('${', this.index)
    ) {
      this.index += this.source[this.index] === '\\' ? 2 : 1
    }
    this.blank(start, this.index)
    if (this.source.startsWith('${', this.index)) {
      this.templateDepths.push(this.braceDepth)
      this.braceDepth += 1
      this.index += 2
    } else {
      this.index += 1
    }
  }

  private blank(from: number, to: number): void {
    for (let position = from; position < Math.min(to, this.code.length); position += 1) {
      if (this.code[position] !== '\n') {
        this.code[position] = ' '
      }
    }
  }
}

// The top-level arguments of the call whose opening parenthesis is at `open`, up to its matching close.
const callArguments = (code: string, open: number): string[] => {
  const found: string[] = []
  let depth = 0
  let start = open + 1
  for (let index = open; index < code.length; index += 1) {
    const character = code[index] ?? ''
    if (OPENERS.has(character)) {
      depth += 1
    } else if (CLOSERS.has(character)) {
      depth -= 1
    }
    if ((character === ',' && depth === 1) || depth === 0) {
      found.push(code.slice(start, index).trim())
      start = index + 1
    }
    if (depth === 0) {
      break
    }
  }
  return found.filter((argument) => argument !== '')
}

// `new Date()` reads the clock, `new Date('…')` parses in the machine's zone and `new Date(y, m, …)` builds a local
// time; only a single argument that is not a string, such as `new Date(0)`, means the same instant everywhere.
const newDateUse = (code: string, end: number): string | undefined => {
  const open = /^\s*\(/u.exec(code.slice(end))
  const found = open === null ? [] : callArguments(code, end + open[0].length - 1)
  const [first] = found
  if (first === undefined) {
    return 'new Date()'
  }
  if (/^['"`]/u.test(first)) {
    return 'new Date(<string>)'
  }
  return found.length > 1 ? 'new Date(<fields>)' : undefined
}

const moduleUses = ({ code, strings }: IMaskedSource): IUse[] =>
  strings.flatMap(({ offset, value }) => {
    const name = value.replace(/^node:/u, '').split('/')[0] ?? ''
    const before = code.slice(Math.max(0, offset - SPECIFIER_LOOKBEHIND), offset)
    return BANNED_MODULES.has(name) && MODULE_SPECIFIER.test(before) ? [{ offset, api: `node:${name}` }] : []
  })

const patternUses = (code: string): IUse[] =>
  BANNED_PATTERNS.flatMap(([pattern, api]) =>
    [...code.matchAll(pattern)].map((match) => ({ offset: match.index, api: api ?? match.groups?.api ?? match[0] }))
  )

const newDateUses = (code: string): IUse[] =>
  [...code.matchAll(NEW_DATE)].flatMap((match) => {
    const api = newDateUse(code, match.index + match[0].length)
    return api === undefined ? [] : [{ offset: match.index, api }]
  })

const lineOf = (code: string, offset: number): number => code.slice(0, offset).split('\n').length

const scanFile = async (packageDirectory: string, file: string): Promise<IPurityFinding[]> => {
  const masked = new SourceMasker(await readFile(join(packageDirectory, file), 'utf8')).mask()
  return [...moduleUses(masked), ...patternUses(masked.code), ...newDateUses(masked.code)]
    .toSorted((left, right) => left.offset - right.offset)
    .map(({ offset, api }) => ({ file, line: lineOf(masked.code, offset), api }))
}

const isScannedSource = (name: string): boolean => name.endsWith('.ts') && !name.endsWith('.test.ts')

const readEntries = async (path: string): Promise<{ name: string; parentPath: string; isFile: () => boolean }[]> => {
  try {
    return await readdir(path, { recursive: true, withFileTypes: true })
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return []
    }
    throw error
  }
}

const listSources = async (packageDirectory: string, directory: string): Promise<string[]> => {
  const entries = await readEntries(join(packageDirectory, directory))
  return entries
    .filter((entry) => entry.isFile() && isScannedSource(entry.name))
    .map((entry) => join(entry.parentPath, entry.name).slice(packageDirectory.length + 1))
}

// Every use of an API that makes the generator's output depend on the machine, the clock or the zone it runs on, one
// finding per use, in file and position order. A scanned directory that does not exist yet holds nothing to report.
export const scanPurity = async (packageDirectory: string): Promise<IPurityFinding[]> => {
  const listed = await Promise.all(SCANNED_DIRECTORIES.map((directory) => listSources(packageDirectory, directory)))
  const files = [...listed.flat(), ...SCANNED_FILES].toSorted()
  const findings = await Promise.all(files.map((file) => scanFile(packageDirectory, file)))
  return findings.flat()
}
