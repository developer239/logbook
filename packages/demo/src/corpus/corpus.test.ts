import { readFile } from 'node:fs/promises'
import { SESSION_OUTCOMES } from '@log-book/engine'
import { describe, expect, it } from 'vitest'
import { secondLabelModel } from './models.js'
import { CORPUS, DEMO_CORPUS_MARK } from './index.js'

interface IEntry {
  file: string
  // Where the string sits in its file's exports, such as `WORK.shop[0].title`.
  key: string
  // The nearest property name above the string, which says what kind of entry it is.
  property: string
  value: string
}

interface IRule {
  name: string
  breaks: (entry: IEntry, cast: readonly string[]) => boolean
}

const ALLOWED_HOSTS = new Set(['example.com', 'example.org', 'localhost', '127.0.0.1'])
const PROMPT_PROPERTIES = new Set(['prompt', 'openingPrompt'])
const MIN_COMMAND_PREFIX = 40
// Two or more path segments after a slash that does not continue a word, a relative path or a URL.
const ABSOLUTE_PATH = /(?<![\w.:/~-])\/[\w.-]+(?:\/[\w.-]*)+/gu
const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@]+@)?(?<host>[^\s/:?#'"`)]+)/giu
const EMAIL_DOMAIN = /[\w.+-]+@(?<domain>[\w-]+(?:\.[\w-]+)*\.[a-z]{2,})\b/giu
const PLACEHOLDER = /\$(?:ARGUMENTS|[1-9])/u
const FRONT_MATTER = /^---\n[\s\S]*?\n---\n/u

const collectEntries = (value: unknown, file: string, key: string, property: string): IEntry[] => {
  if (typeof value === 'string') {
    return [{ file, key, property, value }]
  }
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown, index) => collectEntries(item, file, `${key}[${String(index)}]`, property))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([name, item]) =>
      collectEntries(item, file, key === '' ? name : `${key}.${name}`, name)
    )
  }
  return []
}

const corpusEntries = (corpus: Record<string, unknown>): IEntry[] =>
  Object.entries(corpus).flatMap(([file, exported]) => collectEntries(exported, file, '', ''))

const isCastEntry = (entry: IEntry): boolean => entry.file === 'projects.ts' && entry.key.startsWith('CAST[')

const castOf = (entries: readonly IEntry[]): string[] => entries.filter(isCastEntry).map((entry) => entry.value)

const commandPrefix = (file: string): string => {
  const body = file.replace(FRONT_MATTER, '')
  const placeholder = PLACEHOLDER.exec(body)
  return placeholder === null ? body : body.slice(0, placeholder.index)
}

const RULES: readonly IRule[] = [
  {
    name: 'every absolute path starts with /home/example/',
    breaks: (entry) =>
      [...entry.value.matchAll(ABSOLUTE_PATH)].some(([path]) => !`${path}/`.startsWith('/home/example/')),
  },
  {
    name: "every URL's host is example.com, example.org, localhost or 127.0.0.1",
    breaks: (entry) =>
      [...entry.value.matchAll(URL_HOST)].some((match) => !ALLOWED_HOSTS.has(match.groups?.host?.toLowerCase() ?? '')),
  },
  {
    name: 'every email address is at example.com',
    breaks: (entry) =>
      [...entry.value.matchAll(EMAIL_DOMAIN)].some((match) => match.groups?.domain?.toLowerCase() !== 'example.com'),
  },
  {
    name: 'a person is named only through a slot filled from the cast',
    breaks: (entry, cast) =>
      !isCastEntry(entry) && cast.some((name) => new RegExp(`\\b${name}\\b`, 'u').test(entry.value)),
  },
  {
    name: 'no string contains the word runner',
    breaks: (entry) => /\brunner\b/iu.test(entry.value),
  },
  {
    name: 'no prompt is one whole string in double quotes',
    breaks: (entry) => {
      const text = entry.value.trim()
      return PROMPT_PROPERTIES.has(entry.property) && text.length >= 2 && text.startsWith('"') && text.endsWith('"')
    },
  },
  {
    name: 'every prompt a scripted session may open with contains a space',
    breaks: (entry) => entry.property === 'openingPrompt' && !entry.value.includes(' '),
  },
  {
    name: 'every command file has at least 40 characters before its first placeholder',
    breaks: (entry) => entry.property === 'commandFile' && commandPrefix(entry.value).length < MIN_COMMAND_PREFIX,
  },
]

const violations = (rule: IRule, corpus: Record<string, unknown>): { file: string; key: string }[] => {
  const entries = corpusEntries(corpus)
  const cast = castOf(entries)
  return entries.filter((entry) => rule.breaks(entry, cast)).map(({ file, key }) => ({ file, key }))
}

const ruleNamed = (name: string): IRule => {
  const rule = RULES.find((candidate) => candidate.name.startsWith(name))
  if (rule === undefined) {
    throw new Error(`No corpus rule starts with ${name}`)
  }
  return rule
}

describe('corpus rules', () => {
  it.each(RULES.map((rule) => [rule.name, rule] as const))('%s', (_name, rule) => {
    // Act
    const found = violations(rule, CORPUS)

    // Assert
    expect(found).toStrictEqual([])
  })

  it.each([
    ['every absolute path', { notes: ['read /srv/app/config.json first'] }, 'PLANTED.notes[0]'],
    ["every URL's host", { link: 'see https://docs.invalid-host.dev/guide' }, 'PLANTED.link'],
    ['every email address', { contact: 'write to someone@mail.invalid.dev' }, 'PLANTED.contact'],
    ['a person is named', { reply: 'Priya already fixed that' }, 'PLANTED.reply'],
    ['no string contains the word runner', { output: 'running on runner' }, 'PLANTED.output'],
    ['no prompt is one whole string', { prompt: '"fix the build"' }, 'PLANTED.prompt'],
    ['every prompt a scripted session', { openingPrompt: ['continue'] }, 'PLANTED.openingPrompt[0]'],
    [
      'every command file',
      { commandFile: '---\ndescription: Release\n---\nRelease $ARGUMENTS now.' },
      'PLANTED.commandFile',
    ],
  ])('reports a planted entry that breaks the rule starting "%s"', (name, planted, key) => {
    // Arrange
    const corpus = { ...CORPUS, 'planted.ts': { PLANTED: planted } }

    // Act
    const found = violations(ruleNamed(name), corpus)

    // Assert
    expect(found).toStrictEqual([{ file: 'planted.ts', key }])
  })

  it('accepts a command file with 40 characters before its first placeholder', () => {
    // Arrange
    const commandFile = `---\ndescription: Release\n---\n${'x'.repeat(MIN_COMMAND_PREFIX)}$1`
    const corpus = { ...CORPUS, 'planted.ts': { PLANTED: { commandFile } } }

    // Act
    const found = violations(ruleNamed('every command file'), corpus)

    // Assert
    expect(found).toStrictEqual([])
  })
})

describe('corpus foundations', () => {
  it('keeps the corpus mark in its form and equal to its data file', async () => {
    // Arrange
    const file = new URL('corpus-mark.json', import.meta.url)

    // Act
    const stored = JSON.parse(await readFile(file, 'utf8')) as { mark: string }

    // Assert
    expect({
      mark: DEMO_CORPUS_MARK,
      isFormed: /^log-book-demo-corpus-[0-9a-f]{32}$/u.test(DEMO_CORPUS_MARK),
    }).toStrictEqual({ mark: stored.mark, isFormed: true })
  })

  it('tags work items with at least 6 goals and all 8 outcomes between them', () => {
    // Arrange
    const items = Object.values(CORPUS['work.ts'].WORK).flat()

    // Act
    const goals = new Set(items.map((item) => item.goal))
    const outcomes = new Set(items.flatMap((item) => item.outcomes))

    // Assert
    expect({
      hasSixGoals: goals.size >= 6,
      outcomes: SESSION_OUTCOMES.filter((outcome) => outcomes.has(outcome)),
    }).toStrictEqual({
      hasSixGoals: true,
      outcomes: [...SESSION_OUTCOMES],
    })
  })

  it.each([
    ['claude-haiku-4-5', 'claude-sonnet-5-5'],
    ['claude-sonnet-5-5', 'claude-haiku-4-5'],
  ])('labels the second sample after %s with %s', (labelModel, expected) => {
    // Act
    const second = secondLabelModel(labelModel)

    // Assert
    expect(second).toBe(expected)
  })
})
