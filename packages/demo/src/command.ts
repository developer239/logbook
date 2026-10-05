import { fileURLToPath } from 'node:url'
import { scanPurity } from './purity.js'

const USAGE = 'Usage: logbook-demo <command>'
const EXIT_FAILURE = 1
const EXIT_USAGE = 2
const PACKAGE_DIRECTORY = fileURLToPath(new URL('..', import.meta.url))

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

// Every command exits 0 on success, 1 on a failure with its one-line message last on stderr, and 2 on a usage error.
export const runCommand = async (args: readonly string[]): Promise<number> => {
  const [command] = args
  if (command === 'purity') {
    return runPurity()
  }
  process.stderr.write(command === undefined ? `${USAGE}\n` : `Unknown command ${command}. ${USAGE}\n`)
  return EXIT_USAGE
}
