import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { dependencyFindings } from './deps.js'

type TFiles = Readonly<Record<string, string>>

const run = promisify(execFile)
const WORKSPACE = 'workspace:*'
const directories: string[] = []

const manifest = (name: string, fields: Readonly<Record<string, readonly string[]>> = {}): string =>
  JSON.stringify({
    name,
    ...Object.fromEntries(
      Object.entries(fields).map(([field, names]) => [field, Object.fromEntries(names.map((dep) => [dep, WORKSPACE]))])
    ),
  })

// A workspace that follows the dependency rule, each package declaring and importing what its row allows.
const FOLLOWING: TFiles = {
  'packages/core/package.json': manifest('@log-book/core'),
  'packages/core/src/index.ts': "export const core = 'example'\n",
  'packages/warehouse/package.json': manifest('@log-book/warehouse', { dependencies: ['@log-book/core'] }),
  'packages/warehouse/src/index.ts': "import { core } from '@log-book/core'\nexport { core }\n",
  'packages/engine/package.json': manifest('@log-book/engine', {
    dependencies: ['@log-book/core', '@log-book/warehouse'],
  }),
  'packages/engine/src/index.ts': "export * from '@log-book/warehouse'\nimport './helper.js'\n",
  'packages/engine/src/helper.ts': 'export {}\n',
  'packages/engine/src/sync.test.ts': "import { core } from '@log-book/warehouse/testing'\nimport './helper.js'\n",
  'packages/adapter-opencode/package.json': manifest('@log-book/adapter-opencode', {
    dependencies: ['@log-book/core'],
  }),
  'packages/demo/package.json': manifest('@log-book/demo', {
    dependencies: ['@log-book/engine'],
    devDependencies: ['@log-book/adapter-opencode'],
  }),
  'packages/demo/src/index.ts': "import { openCodeSourceWriter } from '@log-book/adapter-opencode/source-writer'\n",
  'apps/web/package.json': manifest('@log-book/web', {
    dependencies: ['@log-book/core'],
    devDependencies: ['@log-book/demo'],
  }),
  'apps/web/test/pages.test.ts': "import { buildDemo } from '@log-book/demo'\n",
  'apps/cli/package.json': manifest('@log-book/cli', { dependencies: ['@log-book/engine', '@log-book/web'] }),
  'apps/docs/package.json': manifest('@log-book/docs', { devDependencies: ['@log-book/cli', '@log-book/engine'] }),
  'apps/docs/reference.ts': "import { COMMANDS } from '@log-book/cli/grammar'\n",
  'packages/ci/package.json': manifest('@log-book/ci'),
}

// The findings of the rule on a temporary git workspace holding these files.
const findings = async (files: TFiles): Promise<string[]> => {
  const root = await mkdtemp(join(tmpdir(), 'ci-deps-'))
  directories.push(root)
  await Promise.all(
    Object.entries(files).map(async ([path, text]) => {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), text)
    })
  )
  await run('git', ['init', '-q'], { cwd: root })
  await run('git', ['add', '-A'], { cwd: root })
  return dependencyFindings(root)
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
})

describe('the dependency rule check', () => {
  it('passes a workspace that follows the table', async () => {
    // Act
    const found = await findings(FOLLOWING)

    // Assert
    expect(found).toStrictEqual([])
  })

  it.each([
    [
      'engine declaring web in dependencies',
      {
        'packages/engine/package.json': manifest('@log-book/engine', {
          dependencies: ['@log-book/core', '@log-book/warehouse', '@log-book/web'],
        }),
      },
      'packages/engine/package.json: @log-book/engine may not depend on @log-book/web (dependencies) [dependency-rule]',
    ],
    [
      'core declaring warehouse in devDependencies',
      { 'packages/core/package.json': manifest('@log-book/core', { devDependencies: ['@log-book/warehouse'] }) },
      'packages/core/package.json: @log-book/core may not depend on @log-book/warehouse (devDependencies) ' +
        '[dependency-rule]',
    ],
    [
      'web declaring demo in dependencies',
      { 'apps/web/package.json': manifest('@log-book/web', { dependencies: ['@log-book/core', '@log-book/demo'] }) },
      'apps/web/package.json: @log-book/web may take @log-book/demo only in devDependencies, not dependencies ' +
        '[dependency-rule]',
    ],
    [
      'docs declaring engine in dependencies',
      {
        'apps/docs/package.json': manifest('@log-book/docs', {
          dependencies: ['@log-book/engine'],
          devDependencies: ['@log-book/cli'],
        }),
      },
      'apps/docs/package.json: @log-book/docs may take @log-book/engine only in devDependencies, not dependencies ' +
        '[dependency-rule]',
    ],
    [
      'a package declaring ci',
      { 'packages/core/package.json': manifest('@log-book/core', { devDependencies: ['@log-book/ci'] }) },
      'packages/core/package.json: @log-book/core may not depend on @log-book/ci (devDependencies) [dependency-rule]',
    ],
  ])('refuses %s, naming the importer, the package and the field', async (_case, changed, finding) => {
    // Act
    const found = await findings({ ...FOLLOWING, ...changed })

    // Assert
    expect(found).toStrictEqual([finding])
  })

  it.each([
    [
      'demo imported from web source',
      'apps/web/src/lib/example.ts',
      "import { buildDemo } from '@log-book/demo'",
      'apps/web/src/lib/example.ts:1: @log-book/demo is not allowed in @log-book/web [dependency-rule]',
    ],
    [
      'demo importing an adapter at its root',
      'packages/demo/src/import.ts',
      "import openCode from '@log-book/adapter-opencode'",
      'packages/demo/src/import.ts:1: @log-book/adapter-opencode is not allowed in @log-book/demo [dependency-rule]',
    ],
    [
      'docs importing the cli at its root',
      'apps/docs/cli.ts',
      "import { runCli } from '@log-book/cli'",
      'apps/docs/cli.ts:1: @log-book/cli is not allowed in @log-book/docs [dependency-rule]',
    ],
    [
      'a relative import into another package',
      'packages/engine/src/sync.test.ts',
      "import { store } from './helper.js'\nimport '../../warehouse/src/store.js'",
      'packages/engine/src/sync.test.ts:2: ../../warehouse/src/store.js reaches outside @log-book/engine ' +
        '[dependency-rule]',
    ],
    [
      'a dynamic import into another package',
      'packages/engine/src/sync.test.ts',
      "const core = await import('../../core/src/index.js')",
      'packages/engine/src/sync.test.ts:1: ../../core/src/index.js reaches outside @log-book/engine [dependency-rule]',
    ],
    [
      'a require into another package',
      'packages/engine/src/sync.test.ts',
      "const core = require('../../core/src/index.js')",
      'packages/engine/src/sync.test.ts:1: ../../core/src/index.js reaches outside @log-book/engine [dependency-rule]',
    ],
  ])('refuses %s, naming the file, the line and the specifier', async (_case, file, text, finding) => {
    // Act
    const found = await findings({ ...FOLLOWING, [file]: `${text}\n` })

    // Assert
    expect(found).toStrictEqual([finding])
  })
})
