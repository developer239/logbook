import { afterEach, describe, expect, it } from 'vitest'
import { gitWorkspaces } from '../testing/git-workspace.js'
import { dependencyFindings } from './deps.js'

type TFiles = Readonly<Record<string, string>>

const WORKSPACE = 'workspace:*'
const workspaces = gitWorkspaces()

const manifest = (name: string, fields: Readonly<Record<string, readonly string[]>> = {}): string =>
  JSON.stringify({
    name,
    ...Object.fromEntries(
      Object.entries(fields).map(([field, names]) => [field, Object.fromEntries(names.map((dep) => [dep, WORKSPACE]))])
    ),
  })

// Source lines built at run time, so this file's own text holds no import specifier for the check to find when it
// scans the repository.
const quoted = (specifier: string): string => `'${specifier}'`
const importFrom = (clause: string, specifier: string): string => `import ${clause} from ${quoted(specifier)}`
const exportFrom = (specifier: string): string => `export * from ${quoted(specifier)}`
const sideEffect = (specifier: string): string => `import ${quoted(specifier)}`
const dynamicImport = (specifier: string): string => `const loaded = await import(${quoted(specifier)})`
const requireCall = (specifier: string): string => `const loaded = require(${quoted(specifier)})`
const source = (...lines: string[]): string => `${lines.join('\n')}\n`

// A workspace that follows the dependency rule, each package declaring and importing what its row allows.
const FOLLOWING: TFiles = {
  'packages/core/package.json': manifest('@log-book/core'),
  'packages/core/src/index.ts': "export const core = 'example'\n",
  'packages/warehouse/package.json': manifest('@log-book/warehouse', { dependencies: ['@log-book/core'] }),
  'packages/warehouse/src/index.ts': source(importFrom('{ core }', '@log-book/core'), 'export { core }'),
  'packages/engine/package.json': manifest('@log-book/engine', {
    dependencies: ['@log-book/core', '@log-book/warehouse'],
  }),
  'packages/engine/src/index.ts': source(exportFrom('@log-book/warehouse'), sideEffect('./helper.js')),
  'packages/engine/src/helper.ts': 'export {}\n',
  'packages/engine/src/sync.test.ts': source(
    importFrom('{ core }', '@log-book/warehouse/testing'),
    sideEffect('./helper.js')
  ),
  'packages/adapter-opencode/package.json': manifest('@log-book/adapter-opencode', {
    dependencies: ['@log-book/core'],
  }),
  'packages/demo/package.json': manifest('@log-book/demo', {
    dependencies: ['@log-book/engine'],
    devDependencies: ['@log-book/adapter-opencode'],
  }),
  'packages/demo/src/index.ts': source(
    importFrom('{ openCodeSourceWriter }', '@log-book/adapter-opencode/source-writer')
  ),
  'apps/web/package.json': manifest('@log-book/web', {
    dependencies: ['@log-book/core'],
    devDependencies: ['@log-book/demo'],
  }),
  'apps/web/test/pages.test.ts': source(importFrom('{ buildDemo }', '@log-book/demo')),
  'apps/cli/package.json': manifest('@log-book/cli', { dependencies: ['@log-book/engine', '@log-book/web'] }),
  'apps/docs/package.json': manifest('@log-book/docs', { devDependencies: ['@log-book/cli', '@log-book/engine'] }),
  'apps/docs/reference.ts': source(importFrom('{ COMMANDS }', '@log-book/cli/grammar')),
  'packages/ci/package.json': manifest('@log-book/ci'),
}

// The findings of the rule on a temporary git workspace holding these files.
const findings = async (files: TFiles): Promise<string[]> => dependencyFindings(await workspaces.create(files))

afterEach(async () => {
  await workspaces.removeAll()
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
      source(importFrom('{ buildDemo }', '@log-book/demo')),
      'apps/web/src/lib/example.ts:1: @log-book/demo is not allowed in @log-book/web [dependency-rule]',
    ],
    [
      'demo importing an adapter at its root',
      'packages/demo/src/import.ts',
      source(importFrom('openCode', '@log-book/adapter-opencode')),
      'packages/demo/src/import.ts:1: @log-book/adapter-opencode is not allowed in @log-book/demo [dependency-rule]',
    ],
    [
      'docs importing the cli at its root',
      'apps/docs/cli.ts',
      source(importFrom('{ runCli }', '@log-book/cli')),
      'apps/docs/cli.ts:1: @log-book/cli is not allowed in @log-book/docs [dependency-rule]',
    ],
    [
      'a relative import into another package',
      'packages/engine/src/sync.test.ts',
      source(importFrom('{ store }', './helper.js'), sideEffect('../../warehouse/src/store.js')),
      'packages/engine/src/sync.test.ts:2: ../../warehouse/src/store.js reaches outside @log-book/engine ' +
        '[dependency-rule]',
    ],
    [
      'a dynamic import into another package',
      'packages/engine/src/sync.test.ts',
      source(dynamicImport('../../core/src/index.js')),
      'packages/engine/src/sync.test.ts:1: ../../core/src/index.js reaches outside @log-book/engine [dependency-rule]',
    ],
    [
      'a require into another package',
      'packages/engine/src/sync.test.ts',
      source(requireCall('../../core/src/index.js')),
      'packages/engine/src/sync.test.ts:1: ../../core/src/index.js reaches outside @log-book/engine [dependency-rule]',
    ],
  ])('refuses %s, naming the file, the line and the specifier', async (_case, file, text, finding) => {
    // Act
    const found = await findings({ ...FOLLOWING, [file]: text })

    // Assert
    expect(found).toStrictEqual([finding])
  })
})
