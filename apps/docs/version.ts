import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const UNTAGGED = 'main'

// The release the site is built from: the tag at the checked-out commit as it is, such as v1.4.0, the highest version
// when several point there, or main when none does. A git failure stops the build.
export const versionAt = async (directory: string): Promise<string> => {
  const { stdout } = await run('git', ['tag', '--points-at', 'HEAD', '--sort=-v:refname'], { cwd: directory })
  const [tag] = stdout.split('\n').filter((line) => line !== '')
  return tag ?? UNTAGGED
}
