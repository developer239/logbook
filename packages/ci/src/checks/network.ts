import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { trackedFiles } from '../tracked-files.js'

const ALLOWLIST = 'packages/engine/network-call-sites.json'
// The packages whose code reaches users: the seven published ones and the web app the CLI bundles.
const SHIPPED = [
  'packages/core',
  'packages/warehouse',
  'packages/adapter-api',
  'packages/adapter-claude-code',
  'packages/adapter-opencode',
  'packages/engine',
  'apps/cli',
  'apps/web',
]
const SOURCE = /\.(?:ts|tsx|mts|cts|astro|js|mjs|cjs)$/u
// Tests, and the testing subpaths, which stay in the workspace and are not published.
const TEST = /\.test\.[cm]?tsx?$|\/src\/testing\//u
const MODULES = String.raw`(?:node:)?(?:http|https|net|tls|dgram|dns|child_process)(?:\/[a-z]+)?`
// What makes a file a call site: a fetch, a WebSocket, a process started through core's runSubprocess, whose callers the
// allowlist lists, or a network or process module taken by import, export, import() or require. The pattern a finding
// names is the call or the module as written.
const CALL_SITE = new RegExp(
  String.raw`\bfetch\(|\bWebSocket\b|\brunSubprocess\(|(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"\x60])(?<module>${MODULES})\1`,
  'gu'
)

// A type-only import or export, which the build erases and which calls nothing.
const TYPE_ONLY = /^\s*(?:import|export)\s+type\b/u

// The call sites of a file, by line and pattern.
const callSitesIn = (text: string): { line: number; pattern: string }[] =>
  text
    .split('\n')
    .flatMap((line, index) =>
      TYPE_ONLY.test(line)
        ? []
        : [...line.matchAll(CALL_SITE)].map((match) => ({ line: index + 1, pattern: match.groups?.module ?? match[0] }))
    )

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

// The files the allowlist names, or null when it cannot be read as a list of entries with a file.
const listedFiles = async (root: string): Promise<string[] | null> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, ALLOWLIST), 'utf8'))
    if (!Array.isArray(parsed) || !parsed.every((entry) => isRecord(entry) && typeof entry.file === 'string')) {
      return null
    }
    return parsed.map((entry: Record<string, unknown>) => String(entry.file))
  } catch {
    return null
  }
}

// Every network or process call in the shipped source that the allowlist does not list, by file, line and pattern; and
// every listed file that is missing or makes no such call any more.
export const networkFindings = async (root: string): Promise<string[]> => {
  const listed = await listedFiles(root)
  if (listed === null) {
    return [`${ALLOWLIST}: not a list of entries, each with a file`]
  }
  const scanned = (
    await trackedFiles(
      root,
      SHIPPED.flatMap((directory) => [`${directory}/src`, `${directory}/bin`])
    )
  ).filter((file) => SOURCE.test(file) && !TEST.test(file))
  const unlisted = await Promise.all(
    scanned
      .filter((file) => !listed.includes(file))
      .map(async (file) =>
        callSitesIn(await readFile(join(root, file), 'utf8')).map(
          ({ line, pattern }) =>
            `${file}:${String(line)}: ${pattern} is a call site ${ALLOWLIST} does not list [call-site]`
        )
      )
  )
  const stale = await Promise.all(
    listed.map(async (file) => {
      if (!existsSync(join(root, file))) {
        return [`${ALLOWLIST}: the entry for ${file} names a missing file [stale-entry]`]
      }
      return callSitesIn(await readFile(join(root, file), 'utf8')).length === 0
        ? [`${ALLOWLIST}: the entry for ${file} names a file with no call site [stale-entry]`]
        : []
    })
  )
  return [...unlisted.flat(), ...stale.flat()]
}
