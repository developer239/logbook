import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ARTWORK_FILE,
  CAPTURE_EXTENSIONS,
  COMMITTED_CAPTURES_FILE,
  COVERED_CATEGORIES,
  OWNER_LOGIN,
  SCREENS,
} from '../rules/capture-rules.js'
import { inspectCapture } from './metadata.js'

type Fields = Record<string, unknown>

interface IEntry {
  fields: Fields
  // The entry's file, or its place in the list when it names none.
  name: string
}

const OWNER_FIELDS = ['file', 'sha256', 'source', 'screen', 'covered', 'approval']
const APPROVAL_FIELDS = ['by', 'on', 'pullRequest']
const DEMO_FIELDS = ['file', 'sha256', 'source', 'build', 'page', 'text', 'textSha256']
const BUILD_FIELDS = ['size', 'seed', 'labels', 'anchor']
const UNLABELLED = 'none'
const ISO_TIME_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u
const DAY = /^\d{4}-\d{2}-\d{2}$/u
const EXTENSION = /\.[^./]+$/u

const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sha256Of = async (root: string, file: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(join(root, file)))
    .digest('hex')

const isCapture = (file: string): boolean => CAPTURE_EXTENSIONS.includes(EXTENSION.exec(file)?.[0].toLowerCase() ?? '')

const isPositiveInteger = (value: unknown): boolean => Number.isInteger(value) && Number(value) > 0

const isDay = (value: unknown): boolean =>
  typeof value === 'string' && DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)

// The list a file holds under its key, or a finding that names the file when it is missing or unparsable.
export const listIn = async (root: string, file: string, key: string): Promise<unknown[] | string> => {
  let text: string
  try {
    text = await readFile(join(root, file), 'utf8')
  } catch {
    return `${file}: missing; it holds { "${key}": [...] }`
  }
  try {
    const parsed: unknown = JSON.parse(text)
    const list = isFields(parsed) ? parsed[key] : undefined
    return Array.isArray(list) ? list : `${file}: holds no "${key}" list`
  } catch {
    return `${file}: not valid JSON`
  }
}

// The fields a record lacks and the ones it has beyond those expected.
const fieldFindings = (name: string, where: string, fields: Fields, expected: readonly string[]): string[] => [
  ...expected.filter((field) => !(field in fields)).map((field) => `${name}: M2 lacks ${where}${field}`),
  ...Object.keys(fields)
    .filter((field) => !expected.includes(field))
    .map((field) => `${name}: M2 has an extra field ${where}${field}`),
]

const expectedBuildFields = (build: Fields): string[] =>
  build.labels === UNLABELLED ? BUILD_FIELDS : [...BUILD_FIELDS, 'model']

// M2: a source of demo or owner, and exactly the fields of that source.
const shapeFindings = ({ fields, name }: IEntry): string[] => {
  if (fields.source === 'owner') {
    const { approval } = fields
    return [
      ...fieldFindings(name, '', fields, OWNER_FIELDS),
      ...(isFields(approval) ? fieldFindings(name, 'approval.', approval, APPROVAL_FIELDS) : []),
      ...('approval' in fields && !isFields(approval) ? [`${name}: M2 approval is not an object`] : []),
    ]
  }
  if (fields.source === 'demo') {
    const { build } = fields
    return [
      ...fieldFindings(name, '', fields, DEMO_FIELDS),
      ...(isFields(build) ? fieldFindings(name, 'build.', build, expectedBuildFields(build)) : []),
      ...('build' in fields && !isFields(build) ? [`${name}: M2 build is not an object`] : []),
    ]
  }
  return [`${name}: M2 source is neither demo nor owner`]
}

const isIsoTimeWithZone = (value: unknown): boolean =>
  typeof value === 'string' && ISO_TIME_WITH_ZONE.test(value) && !Number.isNaN(Date.parse(value))

// M3: the build a demo entry was captured from.
const buildFindings = (name: string, build: Fields): string[] => [
  ...(build.size === 'small' || build.size === 'rich' ? [] : [`${name}: M3 build.size is not small or rich`]),
  ...(isPositiveInteger(build.seed) ? [] : [`${name}: M3 build.seed is not a positive integer`]),
  ...(build.labels === 'all' || build.labels === UNLABELLED ? [] : [`${name}: M3 build.labels is not all or none`]),
  ...(isIsoTimeWithZone(build.anchor) ? [] : [`${name}: M3 build.anchor is not an ISO 8601 time with a zone`]),
]

// M3: a demo entry's page and its text capture, tracked with the SHA-256 the entry records.
const pageFindings = async (
  root: string,
  { fields, name }: IEntry,
  tracked: ReadonlySet<string>
): Promise<string[]> => {
  const { page, text, textSha256 } = fields
  const pagePath = typeof page === 'string' && page.startsWith('/') ? [] : [`${name}: M3 page is not a path`]
  if (typeof text !== 'string' || !tracked.has(text)) {
    return [...pagePath, `${name}: M3 text is not a tracked file`]
  }
  const isTextSame = (await sha256Of(root, text)) === textSha256
  return [...pagePath, ...(isTextSame ? [] : [`${name}: M3 textSha256 does not match the text capture`])]
}

// M3: a demo entry's build, page and text capture.
const demoEntryFindings = async (root: string, entry: IEntry, tracked: ReadonlySet<string>): Promise<string[]> => [
  ...buildFindings(entry.name, entry.fields.build as Fields),
  ...(await pageFindings(root, entry, tracked)),
]

const coversEveryCategory = (covered: unknown): boolean =>
  Array.isArray(covered) &&
  covered.length === COVERED_CATEGORIES.length &&
  covered.every((category, index) => category === COVERED_CATEGORIES[index])

// M4: an owner entry's screen, what it covered, its approval, and no text capture of a real page beside it.
const ownerEntryFindings = ({ fields, name }: IEntry, tracked: ReadonlySet<string>): string[] => {
  const approval = fields.approval as Fields
  const file = typeof fields.file === 'string' ? fields.file : ''
  const text = file.replace(EXTENSION, '.txt')
  return [
    ...(typeof fields.screen === 'string' && fields.screen in SCREENS ? [] : [`${name}: M4 screen is not a page name`]),
    ...(coversEveryCategory(fields.covered)
      ? []
      : [`${name}: M4 covered does not hold every category in order (${COVERED_CATEGORIES.join(', ')})`]),
    ...(approval.by === OWNER_LOGIN ? [] : [`${name}: M4 approval.by is not ${OWNER_LOGIN}`]),
    ...(isDay(approval.on) ? [] : [`${name}: M4 approval.on is not a YYYY-MM-DD date`]),
    ...(isPositiveInteger(approval.pullRequest) ? [] : [`${name}: M4 approval.pullRequest is not a positive integer`]),
    ...(file !== '' && tracked.has(text) ? [`${name}: M4 a text capture ${text} is tracked beside it`] : []),
  ]
}

const entryFindings = async (root: string, entry: IEntry, tracked: ReadonlySet<string>): Promise<string[]> => {
  const shape = shapeFindings(entry)
  if (shape.length > 0) {
    return shape
  }
  return entry.fields.source === 'demo' ? demoEntryFindings(root, entry, tracked) : ownerEntryFindings(entry, tracked)
}

const entriesOf = (list: readonly unknown[]): IEntry[] =>
  list.map((value, index) => {
    const fields = isFields(value) ? value : {}
    return {
      fields,
      name: typeof fields.file === 'string' ? fields.file : `${COMMITTED_CAPTURES_FILE} entry ${String(index + 1)}`,
    }
  })

// M1: every tracked image or video is artwork or the file of exactly one entry whose SHA-256 is its bytes', and every
// entry's file is tracked.
const fileFindings = async (
  root: string,
  files: readonly string[],
  artwork: readonly unknown[],
  entries: readonly IEntry[]
): Promise<string[]> => {
  const tracked = new Set(files)
  const captures = files.filter((file) => isCapture(file) && !artwork.includes(file))
  const findings = await Promise.all(
    captures.map(async (file) => {
      const own = entries.filter((entry) => entry.fields.file === file)
      if (own.length === 0) {
        return [`${file}: M1 is neither artwork in ${ARTWORK_FILE} nor an entry of ${COMMITTED_CAPTURES_FILE}`]
      }
      if (own.length > 1) {
        return [`${file}: M1 has ${String(own.length)} entries`]
      }
      return own[0]?.fields.sha256 === (await sha256Of(root, file))
        ? []
        : [`${file}: M1 sha256 does not match its bytes`]
    })
  )
  return [
    ...findings.flat(),
    ...entries
      .filter((entry) => typeof entry.fields.file !== 'string' || !tracked.has(entry.fields.file))
      .map((entry) => `${entry.name}: M1 file is not tracked`),
  ]
}

// M5: the metadata a tracked capture of either source carries, or why its structure cannot be read to its end.
const metadataFindings = async (
  root: string,
  entries: readonly IEntry[],
  tracked: ReadonlySet<string>
): Promise<string[]> => {
  const files = [
    ...new Set(
      entries.flatMap(({ fields }) =>
        typeof fields.file === 'string' && tracked.has(fields.file) ? [fields.file] : []
      )
    ),
  ]
  const findings = await Promise.all(
    files.map(async (file) => {
      const inspection = inspectCapture(await readFile(join(root, file)))
      return 'problem' in inspection
        ? [`${file}: M5 cannot be shown to carry no metadata: ${inspection.problem}`]
        : inspection.found.map((name) => `${file}: M5 carries ${name}`)
    })
  )
  return findings.flat()
}

// Rules M1 to M5 over the repository's tracked files: the committed images and videos against the artwork list and the
// committed capture manifest, and the metadata a capture carries. A missing or unparsable list fails, naming it.
export const captureFindings = async (root: string, files: readonly string[]): Promise<string[]> => {
  const [artwork, captures] = await Promise.all([
    listIn(root, ARTWORK_FILE, 'files'),
    listIn(root, COMMITTED_CAPTURES_FILE, 'captures'),
  ])
  if (typeof artwork === 'string' || typeof captures === 'string') {
    return [artwork, captures].filter((each) => typeof each === 'string')
  }
  const entries = entriesOf(captures)
  const tracked = new Set(files)
  const perEntry = await Promise.all(entries.map(async (entry) => entryFindings(root, entry, tracked)))
  return [
    ...(await fileFindings(root, files, artwork, entries)),
    ...perEntry.flat(),
    ...(await metadataFindings(root, entries, tracked)),
  ]
}
