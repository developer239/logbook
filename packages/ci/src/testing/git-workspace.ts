import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Temporary git workspaces for the checks' tests, each holding the files a test plants, all tracked.
export const gitWorkspaces = (): {
  create: (files: Readonly<Record<string, string | Uint8Array>>) => Promise<string>
  removeAll: () => Promise<void>
} => {
  const roots: string[] = []
  return {
    create: async (files) => {
      const root = await mkdtemp(join(tmpdir(), 'ci-check-'))
      roots.push(root)
      await Promise.all(
        Object.entries(files).map(async ([path, text]) => {
          await mkdir(dirname(join(root, path)), { recursive: true })
          await writeFile(join(root, path), text)
        })
      )
      await run('git', ['init', '-q'], { cwd: root })
      await run('git', ['add', '-A'], { cwd: root })
      return root
    },
    removeAll: async () => {
      await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
    },
  }
}
