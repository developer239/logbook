import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { KNOWN_TOOL_NAMES, KNOWN_TOOLS_FILE, OWNER_LITERALS } from '../rules/owner-literals.js'
import { trackedFiles } from '../tracked-files.js'
import { captureFindings } from './captures.js'

const ADAPTER_DIRECTORY = /^packages\/adapter-(?<id>[^/]+)\//u
// The adapter package every adapter builds on, which is no harness.
const ADAPTER_API = 'api'
const HARNESS_SCANNED = /\.(?:ts|tsx|mts|cts|astro|vue|js|mjs|cjs|json|yaml|yml)$/u
// Adapters and their fixtures, tests, and the demo, which writes harness-native data like a fixture.
const HARNESS_EXEMPT = /^packages\/adapter-[^/]+\/|\.test\.ts$|(?:^|\/)test\/|^packages\/demo\//u
const OWNER_LITERALS_FILE = 'packages/ci/src/rules/owner-literals.ts'
const DEMO_OUT = 'packages/demo/out/'
// The first 16 bytes of every SQLite database file.
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary')
// A file with a NUL byte in this many first bytes is binary.
const BINARY_PROBE_BYTES = 8192

const escaped = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)

// The harness ids: the adapter packages' directory names without `adapter-`, the adapter API excepted, so a new
// adapter brings its id with no change here.
export const harnessIdsIn = (paths: readonly string[]): string[] =>
  [
    ...new Set(
      paths.flatMap((path) => {
        const id = ADAPTER_DIRECTORY.exec(path.endsWith('/') ? path : `${path}/`)?.groups?.id
        return id === undefined || id === ADAPTER_API ? [] : [id]
      })
    ),
  ].toSorted()

const linesOf = async (root: string, file: string): Promise<string[]> =>
  (await readFile(join(root, file), 'utf8')).split('\n')

// Every whole quoted string that is a harness id, in a source file outside the adapters, the tests and the demo.
export const harnessFindings = async (root: string): Promise<string[]> => {
  const files = await trackedFiles(root, ['.'])
  const literals = harnessIdsIn(files).map((id) => ({
    id,
    // The quote, the id and the same quote; \x60 is the backtick.
    found: new RegExp(String.raw`(['"\x60])${escaped(id)}\1`, 'u'),
  }))
  const scanned = files.filter((file) => HARNESS_SCANNED.test(file) && !HARNESS_EXEMPT.test(file))
  const findings = await Promise.all(
    scanned.map(async (file) =>
      (await linesOf(root, file)).flatMap((line, index) =>
        literals
          .filter(({ found }) => found.test(line))
          .map(({ id }) => `${file}:${String(index + 1)}: '${id}' is a harness id outside an adapter [harness-id]`)
      )
    )
  )
  return findings.flat()
}

const firstBytes = async (root: string, file: string): Promise<Buffer> => {
  const handle = await open(join(root, file), 'r')
  try {
    const buffer = Buffer.alloc(BINARY_PROBE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, BINARY_PROBE_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

// A line with the known tool names blanked out, in the known-tool table, where only they may hold an owner literal.
const scannedText = (file: string, line: string): string =>
  file === KNOWN_TOOLS_FILE
    ? KNOWN_TOOL_NAMES.reduce(
        (text, name) => text.replaceAll(new RegExp(String.raw`\b${escaped(name)}\b`, 'giu'), ' '.repeat(name.length)),
        line
      )
    : line

const ownerLineFindings = (file: string, line: string, number: number): string[] => {
  const text = scannedText(file, line).toLowerCase()
  return OWNER_LITERALS.filter((literal) => text.includes(literal.toLowerCase())).map(
    (literal) => `${file}:${String(number)}: ${literal} is an owner-specific literal [owner-literal]`
  )
}

// What a tracked file may not be: a demo build's output, or a SQLite database, which the OpenCode fixture is built
// into at test time and never committed.
const trackedFileFindings = (file: string, head: Buffer): string[] => [
  ...(file.startsWith(DEMO_OUT) ? [`${file}: a demo build's output is tracked [demo-out]`] : []),
  ...(head.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)
    ? [`${file}: a SQLite database is tracked [sqlite]`]
    : []),
]

// Every owner literal in a tracked text file, by file, line and literal and never more of the line; every tracked demo
// build output or SQLite database; and every committed image or video that breaks rules M1 to M4.
export const ownerFindings = async (root: string): Promise<string[]> => {
  const files = await trackedFiles(root, ['.'])
  const findings = await Promise.all(
    files.map(async (file) => {
      const head = await firstBytes(root, file)
      const isText = !head.includes(0)
      const lines = isText && file !== OWNER_LITERALS_FILE ? await linesOf(root, file) : []
      return [
        ...trackedFileFindings(file, head),
        ...lines.flatMap((line, index) => ownerLineFindings(file, line, index + 1)),
      ]
    })
  )
  return [...findings.flat(), ...(await captureFindings(root, files))]
}
