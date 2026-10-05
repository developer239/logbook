import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CookbookError } from './errors'

const run = promisify(execFile)

// Every write to the warehouse goes through the cookbook's CLI, which runs with
// the same environment, so TELEMETRY_DB points both at one file.
export const runCookbook = async (args: readonly string[]): Promise<void> => {
  const dir = process.env['COOKBOOK_DIR']

  if (dir === undefined) {
    throw new CookbookError('Set COOKBOOK_DIR to the cookbook checkout to write to the warehouse from here.')
  }

  const cli = join(dir, 'dist', 'modules', 'telemetry', 'cli.js')

  if (!existsSync(cli)) {
    throw new CookbookError(`No cookbook CLI at ${cli}. Build the cookbook first.`)
  }

  try {
    await run(process.execPath, [cli, ...args], { cwd: dir, maxBuffer: 16 * 1024 * 1024 })
  } catch (error) {
    // The CLI writes its progress and, last, its error to stderr.
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : ''
    const last = stderr.trim().split('\n').at(-1)

    throw new CookbookError(
      `The cookbook's ${args[0] ?? 'command'} failed: ${last === undefined || last === '' ? String(error) : last}`
    )
  }
}
