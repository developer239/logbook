import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// Text captures by file name, such as dashboard-dark.txt or tour-1.txt.
export type TextCaptures = Readonly<Record<string, string>>

interface IChange {
  id: string
  added: number
  removed: number
}

// From dist/scripts where the build leaves this module.
const CAPTURES = fileURLToPath(new URL('../../src/public/captures/', import.meta.url))
// A shot's capture names its scheme, a video's its place in the video.
const CAPTURE_FILE = /^(?<id>.+)-(?:dark|light|\d+)\.txt$/u
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
// Every run of digits and every month or weekday name, full or in its three-letter short form, as the web app writes
// them, capitalised; the longest form first, so a full name is not read as its short form and a rest.
const VARIABLE = new RegExp(
  `\\d+|\\b(?:${[...MONTHS, ...WEEKDAYS]
    .flatMap((name) => [name, name.slice(0, 3)])
    .toSorted((left, right) => right.length - left.length)
    .join('|')})\\b`,
  'gu'
)
const PLACEHOLDER = '#'

// The capture's lines with every date, time and count replaced by one placeholder, because the rich set's anchor is the
// build's hour and they can differ between two builds of an unchanged page; what remains is wording. An empty line
// holds none.
const normalisedLines = (text: string): Set<string> =>
  new Set(
    text
      .replaceAll(VARIABLE, PLACEHOLDER)
      .split('\n')
      .filter((line) => line !== '')
  )

const idOf = (file: string): string => CAPTURE_FILE.exec(file)?.groups?.id ?? file

// The lines one capture gained and lost, as sets; a capture on one side only gains or loses all of its lines and
// counts as changed even when it holds none.
const lineChanges = (
  current: string | undefined,
  baseline: string | undefined
): { added: number; removed: number; isChanged: boolean } => {
  const now = normalisedLines(current ?? '')
  const before = normalisedLines(baseline ?? '')
  const added = [...now].filter((line) => !before.has(line)).length
  const removed = [...before].filter((line) => !now.has(line)).length
  return { added, removed, isChanged: added + removed > 0 || current === undefined || baseline === undefined }
}

// Every shot or video whose text captures differ in either scheme, by id, with the lines added and removed.
const textChangesOf = (current: TextCaptures, baseline: TextCaptures): IChange[] => {
  const files = [...new Set([...Object.keys(current), ...Object.keys(baseline)])]
  const changes = new Map<string, IChange>()
  for (const file of files) {
    const { added, removed, isChanged } = lineChanges(current[file], baseline[file])
    if (isChanged) {
      const id = idOf(file)
      const known = changes.get(id) ?? { id, added: 0, removed: 0 }
      changes.set(id, { id, added: known.added + added, removed: known.removed + removed })
    }
  }
  return [...changes.values()].toSorted((left, right) => left.id.localeCompare(right.id))
}

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`

// The report as Markdown for the job summary; with no baseline, one line saying so and nothing listed.
export const textChangesReport = (current: TextCaptures, baseline: TextCaptures | null): string => {
  const heading = '### Shots whose text changed against main\n\n'
  if (baseline === null) {
    return `${heading}There is no baseline of text captures to compare with, so no shot is listed.\n`
  }
  const changes = textChangesOf(current, baseline)
  if (changes.length === 0) {
    return `${heading}No shot's or video's text changed.\n`
  }
  return `${heading}${changes
    .map(
      ({ id, added, removed }) => `- \`${id}\`: ${plural(added, 'line')} added, ${plural(removed, 'line')} removed\n`
    )
    .join('')}`
}

// The text captures of a directory, or null when it does not exist or holds none.
const capturesIn = async (directory: string): Promise<TextCaptures | null> => {
  if (!existsSync(directory)) {
    return null
  }
  const files = (await readdir(directory)).filter((file) => file.endsWith('.txt'))
  if (files.length === 0) {
    return null
  }
  const texts = await Promise.all(
    files.map(async (file): Promise<[string, string]> => [file, await readFile(join(directory, file), 'utf8')])
  )
  return Object.fromEntries(texts)
}

// pnpm docs:text-changes --baseline <dir>: compares this build's text captures with those in the directory, resolved
// against the directory pnpm was started in, and prints which shots' text changed. It reports and never fails.
export const runTextChanges = async (
  argv: readonly string[],
  write: (text: string) => void,
  captures = CAPTURES
): Promise<number> => {
  const { values } = parseArgs({ args: [...argv], options: { baseline: { type: 'string' } }, strict: true })
  if (values.baseline === undefined) {
    write('Usage: pnpm docs:text-changes --baseline <dir>\n')
    return 2
  }
  const baseline = await capturesIn(resolve(process.env.INIT_CWD ?? process.cwd(), values.baseline))
  write(textChangesReport((await capturesIn(captures)) ?? {}, baseline))
  return 0
}
