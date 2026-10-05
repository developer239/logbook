import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const MAX_LISTING_BYTES = 64 * 1024 * 1024

// The files git tracks under these directories of the repository at root, relative to it.
export const trackedFiles = async (root: string, directories: readonly string[]): Promise<string[]> => {
  const { stdout } = await run('git', ['ls-files', '-z', '--', ...directories], {
    cwd: root,
    maxBuffer: MAX_LISTING_BYTES,
  })
  return stdout.split('\0').filter((file) => file !== '')
}
