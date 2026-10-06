import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const MAX_FILE_BYTES = 64 * 1024 * 1024

const WAREHOUSE_SOURCE = 'packages/warehouse/src/'
const DECLARATION = /\b(?:const|let|var)\s+MIGRATIONS\b/gu
// The declaration up to the `[` of the array it is set to, past an optional type.
const ARRAY_START = /\b(?:const|let|var)\s+MIGRATIONS\s*(?::[^=]*)?=\s*\[/u
const TASK_VERSIONS = 'packages/engine/src/labels/tasks/versions.json'

const OPENING: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' }

const show = async (root: string, ref: string, path: string): Promise<string> => {
  const { stdout } = await run('git', ['show', `${ref}:${path}`], { cwd: root, maxBuffer: MAX_FILE_BYTES })
  return stdout
}

// The end of the quoted string or template literal that opens at `start`; a template's placeholders may hold anything,
// templates and strings included.
const stringEnd = (text: string, start: number): number => {
  const quote = text[start]
  let at = start + 1
  while (at < text.length) {
    const character = text[at]
    if (character === '\\') {
      at += 2
    } else if (character === quote) {
      return at + 1
    } else if (quote === '`' && text.startsWith('${', at)) {
      at = bracketedEnd(text, at + 1)
    } else {
      at += 1
    }
  }
  throw new Error('An unterminated string')
}

// The end of a comment opening at `start`, or undefined when no comment opens there.
const commentEnd = (text: string, start: number): number | undefined => {
  if (text.startsWith('//', start)) {
    const end = text.indexOf('\n', start)
    return end === -1 ? text.length : end
  }
  if (text.startsWith('/*', start)) {
    const end = text.indexOf('*/', start + 2)
    if (end === -1) {
      throw new Error('An unterminated comment')
    }
    return end + 2
  }
  return undefined
}

// Where scanning resumes past a comment, a string, a template or a bracketed span opening at `at`, or undefined when
// none opens there.
const skippedTo = (text: string, at: number): number | undefined => {
  const character = text[at] ?? ''
  if (character === '"' || character === "'" || character === '`') {
    return stringEnd(text, at)
  }
  return character in OPENING ? bracketedEnd(text, at) : commentEnd(text, at)
}

// The end of the bracketed span opening at `start`, past its closing bracket, skipping strings and comments.
const bracketedEnd = (text: string, start: number): number => {
  const closing = OPENING[text[start] ?? '']
  let at = start + 1
  while (at < text.length) {
    if (text[at] === closing) {
      return at + 1
    }
    at = skippedTo(text, at) ?? at + 1
  }
  throw new Error('An unclosed bracket')
}

// What starts at `at` inside an array literal, and where the scan goes on after it.
const arrayTokenAt = (text: string, at: number): { kind: 'end' | 'comma' | 'blank' | 'value'; next: number } => {
  const character = text[at] ?? ''
  if (character === ']') {
    return { kind: 'end', next: at }
  }
  if (character === ',') {
    return { kind: 'comma', next: at + 1 }
  }
  const comment = commentEnd(text, at)
  if (comment !== undefined || /\s/u.test(character)) {
    return { kind: 'blank', next: comment ?? at + 1 }
  }
  return { kind: 'value', next: skippedTo(text, at) ?? at + 1 }
}

// The number of entries of the array literal whose `[` is at `start`: the top-level elements between its commas,
// comments and a trailing comma not counted.
const entriesOf = (text: string, start: number): number => {
  let at = start + 1
  let entries = 0
  let isInEntry = false
  while (at < text.length) {
    const token = arrayTokenAt(text, at)
    if (token.kind === 'end') {
      return entries
    }
    if (token.kind === 'comma') {
      isInEntry = false
    } else if (token.kind === 'value' && !isInEntry) {
      isInEntry = true
      entries += 1
    }
    at = token.next
  }
  throw new Error('An unclosed array')
}

// The warehouse schema version at a ref: the number of entries of the warehouse package's MIGRATIONS array, read from
// its source with git show, never built or run.
export const schemaVersionAt = async (root: string, ref: string): Promise<number> => {
  const { stdout } = await run('git', ['ls-tree', '-r', '--name-only', ref, '--', WAREHOUSE_SOURCE], { cwd: root })
  const files = stdout.split('\n').filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  const sources = await Promise.all(files.map(async (file) => ({ file, text: await show(root, ref, file) })))
  const declared = sources.flatMap(({ file, text }) => [...text.matchAll(DECLARATION)].map(() => ({ file, text })))
  const [declaration] = declared
  if (declared.length !== 1 || declaration === undefined) {
    throw new Error(
      `${ref}: ${WAREHOUSE_SOURCE} declares MIGRATIONS ${String(declared.length)} times, not exactly once.`
    )
  }
  const start = ARRAY_START.exec(declaration.text)
  if (start === null) {
    throw new Error(`${ref}: ${declaration.file} does not set MIGRATIONS to an array literal.`)
  }
  try {
    return entriesOf(declaration.text, start.index + start[0].length - 1)
  } catch (error) {
    throw new Error(
      `${ref}: the entries of MIGRATIONS in ${declaration.file} cannot be counted: ${(error as Error).message}.`,
      { cause: error }
    )
  }
}

// The labelling tasks' prompt versions at a ref, in the file's order.
const taskVersionsAt = async (root: string, ref: string): Promise<[string, unknown][]> => {
  const parsed: unknown = JSON.parse(await show(root, ref, TASK_VERSIONS))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${ref}: ${TASK_VERSIONS} holds no object of task versions.`)
  }
  return Object.entries(parsed)
}

const migrationLine = (version: number): string =>
  `This version migrates the warehouse to schema ${String(version)}. Earlier versions of Log Book cannot open it ` +
  'afterwards (exit 6).'

const taskLine = (task: string, before: unknown, after: unknown): string =>
  `This version changes the labelling task \`${task}\` from version ${String(before)} to ${String(after)}. The next ` +
  `\`logbook labels update\` labels again everything that task labelled, on your own Claude plan; \`logbook labels ` +
  'plan` prints the estimate for your warehouse before any call is made.'

// The lines a release's notes gain: a warehouse migration since the previous tag, then each labelling task whose prompt
// version changed, in the file's order. The first release, with no previous tag, gains none.
export const releaseNotes = async (root: string, previous: string, ref: string): Promise<string[]> => {
  if (previous === '') {
    return []
  }
  const [before, after] = [await schemaVersionAt(root, previous), await schemaVersionAt(root, ref)]
  const [oldTasks, newTasks] = [await taskVersionsAt(root, previous), await taskVersionsAt(root, ref)]
  const oldVersions = new Map(oldTasks)
  const newVersions = new Map(newTasks)
  const unmatched = [
    ...oldTasks.filter(([task]) => !newVersions.has(task)),
    ...newTasks.filter(([task]) => !oldVersions.has(task)),
  ].map(([task]) => task)
  if (unmatched.length > 0) {
    throw new Error(
      `${TASK_VERSIONS} names the task ${unmatched.join(', ')} at only one of ${previous} and ${ref}; a release that ` +
        'adds or removes a task has its note written by hand.'
    )
  }
  return [
    ...(after > before ? [migrationLine(after)] : []),
    ...newTasks
      .filter(([task, version]) => oldVersions.get(task) !== version)
      .map(([task, version]) => taskLine(task, oldVersions.get(task), version)),
  ]
}
