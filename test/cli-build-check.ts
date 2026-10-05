import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The bundle `pnpm build` stages: the demo imports its home through it, so a web or end-to-end run after a source
// change but before a build would test yesterday's engine.
const BUILT_CLI = 'apps/cli/package/dist/cli.mjs'
const CLI_PACKAGE = 'apps/cli'
const WORKSPACE_PACKAGES = '{apps,packages}/*/package.json'

interface IManifest {
  name?: string
  dependencies?: Record<string, string>
}

const manifestOf = (path: string): IManifest => JSON.parse(readFileSync(path, 'utf8')) as IManifest

// The CLI's package and every workspace package it depends on, directly or not, as the manifests' `workspace:*`
// dependencies say, so a package added later is covered with no change here.
const packagesOfCli = (root: string): string[] => {
  const directories = new Map(
    globSync(WORKSPACE_PACKAGES, { cwd: root }).map((path) => [manifestOf(join(root, path)).name ?? '', dirname(path)])
  )
  const found = new Set<string>()
  const visit = (directory: string): void => {
    if (found.has(directory)) {
      return
    }
    found.add(directory)
    const dependencies = manifestOf(join(root, directory, 'package.json')).dependencies ?? {}
    for (const [name, range] of Object.entries(dependencies)) {
      const dependency = directories.get(name)
      if (range.startsWith('workspace:') && dependency !== undefined) {
        visit(dependency)
      }
    }
  }
  visit(CLI_PACKAGE)
  return [...found]
}

// Why the built CLI cannot serve this run, or null when it is newer than every file it is built from: everything
// under `src/` of those packages, the engine's prompt files among them.
export const staleCliProblem = (root: string): string | null => {
  const built = join(root, BUILT_CLI)
  if (!existsSync(built)) {
    return 'the built CLI is missing; run pnpm build'
  }
  const builtAt = statSync(built).mtimeMs
  const isStale = packagesOfCli(root)
    .flatMap((directory) => globSync(join(directory, 'src', '**', '*'), { cwd: root }))
    .some((path) => {
      const stats = statSync(join(root, path))
      return stats.isFile() && stats.mtimeMs > builtAt
    })
  return isStale ? 'the built CLI is older than the sources; run pnpm build' : null
}

// The web and end-to-end projects' first global setup, in the main Vitest process: a stale build stops the run before
// any test starts and before the demo is built. CI builds before it tests, so it passes there with no exception.
export const setup = (): void => {
  const problem = staleCliProblem(fileURLToPath(new URL('..', import.meta.url)))
  if (problem !== null) {
    throw new Error(problem)
  }
}
