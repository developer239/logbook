import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { isLabelModelId, LABEL_MODEL_RULE, LogBookError } from '@log-book/core'
import { buildDemo, thisHour, type IBuildOptions } from './build/build-demo.js'
import type { DemoSize, LabelsVariant } from './plan/types.js'
import { scanPurity } from './purity.js'

const USAGE = 'Usage: logbook-demo <command>'
const EXIT_FAILURE = 1
const EXIT_USAGE = 2
const PACKAGE_DIRECTORY = fileURLToPath(new URL('..', import.meta.url))
const SIZES: readonly DemoSize[] = ['small']
const LABELS: readonly LabelsVariant[] = ['all', 'none']
// An ISO time that names its zone: `Z` or an offset such as `+02:00`.
const ZONED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u
const WHOLE_NUMBER = /^\d+$/u

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

// The build's options from its command line; a value not given leaves buildDemo's default.
export const buildOptionsOf = (args: readonly string[], now: number): IBuildOptions => {
  const { values } = parseArgs({
    args: [...args],
    options: {
      size: { type: 'string' },
      seed: { type: 'string' },
      anchor: { type: 'string' },
      labels: { type: 'string' },
      model: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
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

// Every command exits 0 on success, 1 on a failure with its one-line message last on stderr, and 2 on a usage error.
export const runCommand = async (args: readonly string[]): Promise<number> => {
  const [command, ...rest] = args
  if (command === 'purity') {
    return runPurity()
  }
  if (command === 'build') {
    return runBuild(rest)
  }
  process.stderr.write(command === undefined ? `${USAGE}\n` : `Unknown command ${command}. ${USAGE}\n`)
  return EXIT_USAGE
}
