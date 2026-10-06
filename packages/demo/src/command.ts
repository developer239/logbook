import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { isLabelModelId, LABEL_MODEL_RULE, LogBookError } from '@log-book/core'
import { buildDemo, defaultOut, thisHour, type IBuildOptions } from './build/build-demo.js'
import { checkDemo } from './check/check-demo.js'
import { scanText } from './check/scan-text.js'
import type { DemoSize, LabelsVariant } from './plan/types.js'
import { scanPurity } from './purity.js'
import { removeWarehouse, runHost } from './start/start-demo.js'

const USAGE = 'Usage: logbook-demo <command>'
const EXIT_FAILURE = 1
const EXIT_USAGE = 2
const PACKAGE_DIRECTORY = fileURLToPath(new URL('..', import.meta.url))
const SIZES: readonly DemoSize[] = ['small']
const LABELS: readonly LabelsVariant[] = ['all', 'none']
// An ISO time that names its zone: `Z` or an offset such as `+02:00`.
const ZONED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u
const WHOLE_NUMBER = /^\d+$/u
const MAX_PORT = 65_535

// A command line the command cannot run: its one line names the value.
class UsageLine extends Error {}

// Prints one `<file>:<line> <API>` line per banned use in the generator's sources, paths from the package's parent so
// they read the same from the repository root.
const runPurity = async (): Promise<number> => {
  const findings = await scanPurity(PACKAGE_DIRECTORY)
  if (findings.length === 0) {
    return 0
  }
  for (const { file, line, api } of findings) {
    process.stdout.write(`packages/demo/${file}:${String(line)} ${api}\n`)
  }
  process.stderr.write(`Banned APIs in the generator's sources: ${String(findings.length)}.\n`)
  return EXIT_FAILURE
}

const choiceOf = <TChoice extends string>(option: string, choices: readonly TChoice[], value: string): TChoice => {
  const choice = choices.find((known) => known === value)
  if (choice === undefined) {
    throw new UsageLine(`--${option} takes ${choices.join(' or ')}, got ${value}`)
  }
  return choice
}

// An ISO time with its zone, parsed once into epoch milliseconds, or `now`, the current hour. A time without a zone
// would mean the build machine's local time.
export const parseAnchor = (value: string, now: number): number => {
  if (value === 'now') {
    return thisHour(now)
  }
  const anchor = ZONED_TIME.test(value) ? new Date(value).getTime() : Number.NaN
  if (Number.isNaN(anchor)) {
    throw new UsageLine(`--anchor takes an ISO time with Z or an offset, or now, got ${value}`)
  }
  return anchor
}

const seedOf = (value: string): number => {
  const seed = WHOLE_NUMBER.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(seed)) {
    throw new UsageLine(`--seed takes a whole number, 0 or more, got ${value}`)
  }
  return seed
}

const modelOf = (value: string): string => {
  if (!isLabelModelId(value)) {
    throw new UsageLine(`--model ${LABEL_MODEL_RULE}, got ${JSON.stringify(value)}`)
  }
  return value
}

const BUILD_FLAGS = {
  size: { type: 'string' },
  seed: { type: 'string' },
  anchor: { type: 'string' },
  labels: { type: 'string' },
  model: { type: 'string' },
  out: { type: 'string' },
} as const

type TBuildValues = Partial<Record<keyof typeof BUILD_FLAGS, string>>

const buildOptionsFrom = (values: TBuildValues, now: number): IBuildOptions => {
  const labels = values.labels === undefined ? 'all' : choiceOf('labels', LABELS, values.labels)

  return {
    size: values.size === undefined ? 'small' : choiceOf('size', SIZES, values.size),
    labels,
    ...(values.seed === undefined ? {} : { seed: seedOf(values.seed) }),
    ...(values.anchor === undefined ? {} : { anchor: parseAnchor(values.anchor, now) }),
    // The model names who labels; with no labels there is nothing to check it for.
    ...(values.model === undefined || labels === 'none' ? {} : { model: modelOf(values.model) }),
    ...(values.out === undefined ? {} : { out: values.out }),
  }
}

// The build's options from its command line; a value not given leaves buildDemo's default.
export const buildOptionsOf = (args: readonly string[], now: number): IBuildOptions => {
  const { values } = parseArgs({ args: [...args], options: BUILD_FLAGS, strict: true, allowPositionals: false })
  return buildOptionsFrom(values, now)
}

// Log Book's own port plus one, so a demo host and a real one run side by side and a bookmark to the real one never
// shows demo data.
const DEMO_PORT = 7315

export interface IStartArgs {
  build: IBuildOptions
  port: number
  isFresh: boolean
  isReused: boolean
  isOpen: boolean
}

// The start command's line: the build's flags, then where and how the host runs.
export const startArgsOf = (args: readonly string[], now: number): IStartArgs => {
  const { values } = parseArgs({
    args: [...args],
    options: {
      ...BUILD_FLAGS,
      port: { type: 'string' },
      fresh: { type: 'boolean' },
      reuse: { type: 'boolean' },
      open: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  })
  const { port, fresh, reuse, open, ...build } = values
  const portNumber = port === undefined ? DEMO_PORT : Number(port)
  if (!WHOLE_NUMBER.test(port ?? '0') || portNumber > MAX_PORT) {
    throw new UsageLine(`--port takes a port from 0 to ${String(MAX_PORT)}, got ${port ?? ''}`)
  }
  return {
    build: buildOptionsFrom(build, now),
    port: portNumber,
    isFresh: fresh === true,
    isReused: reuse === true,
    isOpen: open === true,
  }
}

// Builds the set and prints its out directory.
const runBuild = async (args: readonly string[]): Promise<number> => {
  let options: IBuildOptions
  try {
    options = buildOptionsOf(args, Date.now())
  } catch (error: unknown) {
    // Node's own parse errors can run over several lines; a usage error is one.
    const [first] = (error instanceof Error ? error.message : String(error)).split('\n')
    process.stderr.write(`${first ?? ''}\n`)
    return EXIT_USAGE
  }

  try {
    const built = await buildDemo(options)
    process.stdout.write(`${built.out}\n`)
    return 0
  } catch (error: unknown) {
    if (error instanceof LogBookError) {
      process.stderr.write(`${error.message}\n`)
      return EXIT_FAILURE
    }
    throw error
  }
}

// Checks an out directory, the small set's by default: nothing printed when it passes, one `<rule> <location>` line per
// finding when it does not.
const runCheck = async (args: readonly string[]): Promise<number> => {
  let out: string
  try {
    const { values } = parseArgs({ args: [...args], options: { out: { type: 'string' } }, strict: true })
    out = values.out ?? defaultOut('small')
  } catch (error: unknown) {
    const [first] = (error instanceof Error ? error.message : String(error)).split('\n')
    process.stderr.write(`${first ?? ''}\n`)
    return EXIT_USAGE
  }

  try {
    const findings = await checkDemo(out)
    for (const { rule, location } of findings) {
      process.stdout.write(`${rule} ${location}\n`)
    }
    return findings.length === 0 ? 0 : EXIT_FAILURE
  } catch (error: unknown) {
    if (error instanceof LogBookError) {
      process.stderr.write(`${error.message}\n`)
      return EXIT_FAILURE
    }
    throw error
  }
}

interface IScanArgs {
  files: string[]
  size: DemoSize
  seed: number
}

const scanArgsOf = (args: readonly string[]): IScanArgs => {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { size: { type: 'string' }, seed: { type: 'string' } },
    strict: true,
    allowPositionals: true,
  })
  if (positionals.length === 0) {
    throw new UsageLine('Usage: logbook-demo scan <file>... [--size small] [--seed <n>]')
  }
  return {
    files: positionals,
    size: values.size === undefined ? 'small' : choiceOf('size', SIZES, values.size),
    seed: values.seed === undefined ? 1 : seedOf(values.seed),
  }
}

// Scans text files that carry no manifest against the demo of a size and seed: nothing printed when every file passes,
// one `<file>:<line> <rule>` line per finding when one does not.
const runScan = async (args: readonly string[]): Promise<number> => {
  let scan: IScanArgs
  try {
    scan = scanArgsOf(args)
  } catch (error: unknown) {
    const [first] = (error instanceof Error ? error.message : String(error)).split('\n')
    process.stderr.write(`${first ?? ''}\n`)
    return EXIT_USAGE
  }

  const scanned = await Promise.all(
    scan.files.map(async (file) => ({
      file,
      findings: await scanText(await readFile(file, 'utf8'), { size: scan.size, seed: scan.seed }),
    }))
  )
  const lines = scanned.flatMap(({ file, findings }) =>
    findings.map(({ line, rule }) => `${file}:${String(line)} ${rule}`)
  )
  for (const line of lines) {
    process.stdout.write(`${line}\n`)
  }
  return lines.length === 0 ? 0 : EXIT_FAILURE
}

const usageError = (error: unknown): number => {
  // Node's own parse errors can run over several lines; a usage error is one.
  const [first] = (error instanceof Error ? error.message : String(error)).split('\n')
  process.stderr.write(`${first ?? ''}\n`)
  return EXIT_USAGE
}

// Builds the set, or with --reuse takes its out directory as it is, checks it, and runs a Log Book host on it until
// Ctrl+C ends the host. A finding of the check stops it before any host starts.
const runStart = async (args: readonly string[]): Promise<number> => {
  let start: IStartArgs
  try {
    start = startArgsOf(args, Date.now())
  } catch (error: unknown) {
    return usageError(error)
  }

  const out = resolve(start.build.out ?? defaultOut(start.build.size))
  try {
    if (!start.isReused) {
      await buildDemo({ ...start.build, out })
    }
    const findings = await checkDemo(out)
    if (findings.length > 0) {
      for (const { rule, location } of findings) {
        process.stdout.write(`${rule} ${location}\n`)
      }
      return EXIT_FAILURE
    }
    if (start.isFresh) {
      await removeWarehouse(out)
    }
    return await runHost(out, { port: start.port, isFresh: start.isFresh, isOpen: start.isOpen })
  } catch (error: unknown) {
    if (error instanceof LogBookError) {
      process.stderr.write(`${error.message}\n`)
      return EXIT_FAILURE
    }
    throw error
  }
}

// Every command exits 0 on success, 1 on a failure with its one-line message last on stderr, and 2 on a usage error.
export const runCommand = async (args: readonly string[]): Promise<number> => {
  const [command, ...rest] = args
  if (command === 'purity') {
    return runPurity()
  }
  if (command === 'build') {
    return runBuild(rest)
  }
  if (command === 'check') {
    return runCheck(rest)
  }
  if (command === 'scan') {
    return runScan(rest)
  }
  if (command === 'start') {
    return runStart(rest)
  }
  process.stderr.write(command === undefined ? `${USAGE}\n` : `Unknown command ${command}. ${USAGE}\n`)
  return EXIT_USAGE
}
