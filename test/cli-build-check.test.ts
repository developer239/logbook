import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { staleCliProblem } from './cli-build-check.js'

const SOURCES_AT = new Date('2026-09-01T10:00:00Z')
const BUILT_AT = new Date('2026-09-02T10:00:00Z')
const CHANGED_AT = new Date('2026-09-03T10:00:00Z')
const BUILT = 'apps/cli/package/dist/cli.mjs'

// The CLI depends on the engine, the engine on core; another package stands beside them.
const TREE: Readonly<Record<string, string>> = {
  'apps/cli/package.json': JSON.stringify({
    name: '@log-book/cli',
    dependencies: { '@log-book/engine': 'workspace:*' },
  }),
  'apps/cli/src/grammar.ts': 'export {}\n',
  'packages/engine/package.json': JSON.stringify({
    name: '@log-book/engine',
    dependencies: { '@log-book/core': 'workspace:*' },
  }),
  'packages/engine/src/index.ts': 'export {}\n',
  'packages/engine/src/prompts/shell-label.prompt.txt': 'Label each command.\n',
  'packages/core/package.json': JSON.stringify({ name: '@log-book/core' }),
  'packages/core/src/index.ts': 'export {}\n',
  'packages/demo/package.json': JSON.stringify({
    name: '@log-book/demo',
    dependencies: { '@log-book/core': 'workspace:*' },
  }),
  'packages/demo/src/index.ts': 'export {}\n',
}

describe('staleCliProblem', () => {
  let root = ''

  const touch = async (path: string, at: Date): Promise<void> => utimes(join(root, path), at, at)

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'log-book-cli-build-'))
    await Promise.all(
      Object.entries({ ...TREE, [BUILT]: 'export {}\n' }).map(async ([path, content]) => {
        await mkdir(dirname(join(root, path)), { recursive: true })
        await writeFile(join(root, path), content)
      })
    )
    await Promise.all(Object.keys(TREE).map(async (path) => touch(path, SOURCES_AT)))
    await touch(BUILT, BUILT_AT)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('passes when every source file is older than the built CLI', () => {
    // Act
    const problem = staleCliProblem(root)

    // Assert
    expect(problem).toBeNull()
  })

  it.each([
    ["a file of the CLI's own sources", 'apps/cli/src/grammar.ts'],
    ['a file of a dependency of a dependency', 'packages/core/src/index.ts'],
    ['a prompt file', 'packages/engine/src/prompts/shell-label.prompt.txt'],
  ])('stops the run for %s newer than the built CLI', async (_case, path) => {
    // Arrange
    await touch(path, CHANGED_AT)

    // Act
    const problem = staleCliProblem(root)

    // Assert
    expect(problem).toBe('the built CLI is older than the sources; run pnpm build')
  })

  it('passes a newer file of a package the CLI does not depend on', async () => {
    // Arrange
    await touch('packages/demo/src/index.ts', CHANGED_AT)

    // Act
    const problem = staleCliProblem(root)

    // Assert
    expect(problem).toBeNull()
  })

  it('stops the run when the built CLI is missing', async () => {
    // Arrange
    await rm(join(root, BUILT))

    // Act
    const problem = staleCliProblem(root)

    // Assert
    expect(problem).toBe('the built CLI is missing; run pnpm build')
  })
})
