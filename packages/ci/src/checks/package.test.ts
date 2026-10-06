import { afterEach, describe, expect, it } from 'vitest'
import { gitWorkspaces } from '../testing/git-workspace.js'
import { packageFindings } from './package.js'

const VERSION = '0.0.0-development'
const HOMEPAGE = 'https://example.com/logbook/'
const DESCRIPTION = 'Log Book shows where the time went.'
const REPOSITORY = 'git+https://github.com/developer239/logbook.git'
const BUGS = 'https://github.com/developer239/logbook/issues'
const INDEX = { types: './dist/index.d.ts', default: './dist/index.js' }

// A planted module's import of a workspace package, its specifier apart from `from` so the dependency rule does not read
// the test as importing it.
const importOf = (binding: string, specifier: string): string =>
  [`import { ${binding} } from`, `'${specifier}'`].join(' ')

const LIST = [
  {
    name: '@log-book/core',
    directory: 'packages/core',
    description: 'Helpers',
    exports: ['.'],
    workspaceOnly: [],
    assets: [],
  },
  {
    name: '@log-book/adapter-example',
    directory: 'packages/adapter-example',
    description: 'An example adapter',
    exports: ['.'],
    workspaceOnly: ['./source-writer'],
    assets: [],
  },
  {
    name: '@log-book/cli',
    directory: 'apps/cli',
    description: '',
    exports: [],
    workspaceOnly: ['./grammar'],
    assets: [],
  },
]

const libraryManifest = (
  name: string,
  description: string,
  directory: string,
  dependencies: Record<string, string>
): Record<string, unknown> => ({
  name,
  description,
  version: VERSION,
  license: 'PolyForm-Noncommercial-1.0.0',
  type: 'module',
  engines: { node: '>=24.15' },
  exports: { '.': INDEX },
  files: ['dist/'],
  homepage: HOMEPAGE,
  repository: { type: 'git', url: REPOSITORY, directory },
  bugs: BUGS,
  publishConfig: { access: 'public' },
  dependencies,
})

const CORE = libraryManifest('@log-book/core', 'Helpers', 'packages/core', {})
const ADAPTER = libraryManifest('@log-book/adapter-example', 'An example adapter', 'packages/adapter-example', {
  '@log-book/core': VERSION,
})
const CLI = {
  name: '@log-book/cli',
  description: DESCRIPTION,
  version: VERSION,
  license: 'PolyForm-Noncommercial-1.0.0',
  type: 'module',
  bin: { logbook: 'bin/logbook.cjs' },
  engines: { node: '>=24' },
  os: ['darwin', 'linux'],
  files: ['bin/', 'dist/', 'THIRD-PARTY-NOTICES.md'],
  homepage: HOMEPAGE,
  repository: { type: 'git', url: REPOSITORY, directory: 'apps/cli' },
  bugs: BUGS,
  keywords: ['example', 'coding-agent', 'transcripts', 'analytics', 'local-first'],
  publishConfig: { access: 'public' },
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

// A workspace whose three published packages are built and staged as the stage writes them: the adapter imports core,
// and its source writer stays in the workspace.
const STAGED_WORKSPACE: Readonly<Record<string, string>> = {
  'LICENSE.md': 'The license\n',
  'README.md': `${DESCRIPTION}\n`,
  'apps/docs/site.ts': `export const SITE_URL = '${HOMEPAGE}'\n`,
  'packages/ci/src/rules/public-packages.json': JSON.stringify(LIST),
  'packages/core/package.json': JSON.stringify({ name: '@log-book/core', exports: { '.': INDEX } }),
  'packages/core/dist/index.js': 'export const core = 1\n',
  'packages/core/dist/index.d.ts': 'export declare const core = 1\n',
  'packages/adapter-example/package.json': JSON.stringify({
    name: '@log-book/adapter-example',
    exports: { '.': INDEX, './source-writer': INDEX },
    dependencies: { '@log-book/core': 'workspace:*' },
  }),
  'packages/adapter-example/dist/index.js': `${importOf('core', '@log-book/core')}\nexport const adapter = core\n`,
  'packages/adapter-example/dist/index.d.ts': 'export declare const adapter = 1\n',
  'apps/cli/package.json': JSON.stringify({
    name: '@log-book/cli',
    exports: { './grammar': INDEX },
    bin: { logbook: 'bin/logbook.cjs' },
    engines: { node: '>=24' },
    os: ['darwin', 'linux'],
  }),
  'packages/core/package/package.json': json(CORE),
  'packages/core/package/README.md': '# @log-book/core\n',
  'packages/core/package/LICENSE.md': 'The license\n',
  'packages/core/package/dist/index.js': 'export const core = 1\n',
  'packages/core/package/dist/index.d.ts': 'export declare const core = 1\n',
  'packages/adapter-example/package/package.json': json(ADAPTER),
  'packages/adapter-example/package/README.md': '# @log-book/adapter-example\n',
  'packages/adapter-example/package/LICENSE.md': 'The license\n',
  'packages/adapter-example/package/dist/index.js': `${importOf('core', '@log-book/core')}\nexport const adapter = core\n`,
  'packages/adapter-example/package/dist/index.d.ts': 'export declare const adapter = 1\n',
  'apps/cli/package/package.json': json(CLI),
  'apps/cli/package/README.md': `${DESCRIPTION}\n`,
  'apps/cli/package/LICENSE.md': 'The license\n',
  'apps/cli/package/bin/logbook.cjs': "'use strict'\n",
  'apps/cli/package/dist/cli.mjs': 'export {}\n',
  'apps/cli/package/dist/web/guard.js': 'export {}\n',
  'build/publish-order.txt': 'packages/core/package\npackages/adapter-example/package\napps/cli/package\n',
}

const workspaces = gitWorkspaces()

// The findings on the staged workspace with these files planted over it, and those whose value is null removed.
const findingsWith = async (changes: Readonly<Record<string, string | null>>): Promise<string[]> => {
  const files = Object.fromEntries(
    Object.entries({ ...STAGED_WORKSPACE, ...changes }).filter(
      (pair): pair is [string, string] => typeof pair[1] === 'string'
    )
  )
  return packageFindings(await workspaces.create(files))
}

const withFields = (manifest: Record<string, unknown>, fields: Record<string, unknown>): string =>
  json({ ...manifest, ...fields })

const withoutFields = (manifest: Record<string, unknown>, fields: readonly string[]): string =>
  json(Object.fromEntries(Object.entries(manifest).filter(([field]) => !fields.includes(field))))

afterEach(async () => {
  await workspaces.removeAll()
})

describe('packageFindings', () => {
  it('passes packages staged as their tables say, a library declaration file among them', async () => {
    // Act
    const findings = await findingsWith({})

    // Assert
    expect(findings).toStrictEqual([])
  })

  describe('manifests', () => {
    it("fails on each field of the CLI's table absent", async () => {
      // Arrange
      const fields = Object.keys(CLI).filter((field) => field !== 'name' && field !== 'version')

      // Act
      const findings = await findingsWith({ 'apps/cli/package/package.json': withoutFields(CLI, fields) })

      // Assert
      expect(findings).toStrictEqual(
        fields.map((field) => `@log-book/cli: package.json lacks ${field} [package/manifest-field]`)
      )
    })

    it("fails on each field of the CLI's table changed", async () => {
      // Arrange
      const changed = Object.fromEntries(Object.keys(CLI).map((field) => [field, 'changed']))

      // Act
      const findings = await findingsWith({
        'apps/cli/package/package.json': withFields(CLI, { ...changed, name: '@log-book/cli', version: VERSION }),
      })

      // Assert
      expect(findings).toStrictEqual(
        Object.entries(CLI)
          .filter(([field]) => field !== 'name' && field !== 'version')
          .map(
            ([field, value]) =>
              `@log-book/cli: package.json ${field} is "changed", its table holds ${JSON.stringify(value)} [package/manifest-field]`
          )
      )
    })

    it("fails on each field of a library's table absent", async () => {
      // Arrange
      const fields = Object.keys(CORE).filter((field) => field !== 'name' && field !== 'version')

      // Act
      const findings = await findingsWith({ 'packages/core/package/package.json': withoutFields(CORE, fields) })

      // Assert
      expect(findings).toStrictEqual([
        ...fields
          .filter((field) => field !== 'exports' && field !== 'dependencies')
          .map((field) => `@log-book/core: package.json lacks ${field} [package/manifest-field]`),
        `@log-book/core: package.json exports . is nothing, not ${JSON.stringify(INDEX)} [package/public-exports]`,
        '@log-book/core: package.json dependencies is nothing, not an object [package/dependencies]',
      ])
    })

    it("fails on each field of a library's table changed", async () => {
      // Arrange
      const changed = Object.fromEntries(
        Object.keys(CORE)
          .filter((field) => field !== 'exports' && field !== 'dependencies')
          .map((field) => [field, 'changed'])
      )

      // Act
      const findings = await findingsWith({
        'packages/core/package/package.json': withFields(CORE, {
          ...changed,
          name: '@log-book/core',
          version: VERSION,
          exports: { '.': { types: './dist/main.d.ts', default: './dist/main.js' } },
        }),
      })

      // Assert
      expect(findings).toStrictEqual([
        ...Object.entries(CORE)
          .filter(([field]) => !['name', 'version', 'exports', 'dependencies'].includes(field))
          .map(
            ([field, value]) =>
              `@log-book/core: package.json ${field} is "changed", its table holds ${JSON.stringify(value)} [package/manifest-field]`
          ),
        '@log-book/core: package.json exports . is {"types":"./dist/main.d.ts","default":"./dist/main.js"}, not ' +
          `${JSON.stringify(INDEX)} [package/public-exports]`,
      ])
    })

    it('fails on scripts, a field no table holds', async () => {
      // Act
      const findings = await findingsWith({
        'packages/core/package/package.json': withFields(CORE, { scripts: { prepare: 'node build.js' } }),
      })

      // Assert
      expect(findings).toStrictEqual([
        '@log-book/core: package.json has scripts, which its table does not hold [package/manifest-field]',
      ])
    })

    it.each([
      ['dependencies', { dependencies: { '@log-book/core': VERSION } }],
      ['exports', { exports: { '.': INDEX } }],
    ])("fails on the CLI's manifest with %s", async (field, fields) => {
      // Act
      const findings = await findingsWith({ 'apps/cli/package/package.json': withFields(CLI, fields) })

      // Assert
      expect(findings).toStrictEqual([
        `@log-book/cli: package.json has ${field}; the CLI is one bundle with nothing to install [package/cli-fields]`,
      ])
    })

    it("fails on a library's exports entry the list does not hold as public", async () => {
      // Act
      const findings = await findingsWith({
        'packages/adapter-example/package/package.json': withFields(ADAPTER, {
          exports: { '.': INDEX, './source-writer': INDEX },
        }),
      })

      // Assert
      expect(findings).toStrictEqual([
        '@log-book/adapter-example: package.json exports ./source-writer, which ' +
          'packages/ci/src/rules/public-packages.json does not hold as public [package/public-exports]',
      ])
    })

    it.each([
      [
        'a third-party package',
        { '@log-book/core': VERSION, 'left-pad': '1.3.0' },
        [
          '@log-book/adapter-example: package.json dependencies name left-pad, which is not a @log-book/ package it ' +
            'imports [package/dependencies]',
          '@log-book/adapter-example: package.json dependencies name left-pad at "1.3.0", not 0.0.0-development ' +
            '[package/dependencies]',
        ],
      ],
      [
        '@log-book/core at a range',
        { '@log-book/core': '^0.0.0-development' },
        [
          '@log-book/adapter-example: package.json dependencies name @log-book/core at "^0.0.0-development", not ' +
            '0.0.0-development [package/dependencies]',
        ],
      ],
    ])("fails on a library's dependencies naming %s", async (_case, dependencies, expected) => {
      // Act
      const findings = await findingsWith({
        'packages/adapter-example/package/package.json': withFields(ADAPTER, { dependencies }),
      })

      // Assert
      expect(findings).toStrictEqual(expected)
    })

    it('fails on a workspace subpath the list holds in neither column for its package', async () => {
      // Act
      const findings = await findingsWith({
        'packages/adapter-example/package.json': JSON.stringify({
          name: '@log-book/adapter-example',
          exports: { '.': INDEX, './source-writer': INDEX, './testing': INDEX },
          dependencies: { '@log-book/core': 'workspace:*' },
        }),
      })

      // Assert
      expect(findings).toStrictEqual([
        '@log-book/adapter-example: packages/adapter-example/package.json exports ./testing, which ' +
          'packages/ci/src/rules/public-packages.json holds neither as public nor as workspace-only ' +
          '[package/unlisted-subpath]',
      ])
    })
  })

  describe('file lists', () => {
    it('fails on a staged adapter holding source-writer files', async () => {
      // Act
      const findings = await findingsWith({
        'packages/adapter-example/package/dist/source-writer/index.js': 'export const write = 1\n',
      })

      // Assert
      expect(findings).toStrictEqual([
        '@log-book/adapter-example: dist/source-writer/index.js holds source-writer/ [package/forbidden-path]',
      ])
    })

    it('fails on a .map file', async () => {
      // Act
      const findings = await findingsWith({ 'packages/core/package/dist/index.js.map': '{}\n' })

      // Assert
      expect(findings).toStrictEqual([
        "@log-book/core: dist/index.js.map is outside the package's layout [package/layout]",
        '@log-book/core: dist/index.js.map holds .map [package/forbidden-path]',
      ])
    })

    it("fails on a declaration file in the CLI's list", async () => {
      // Act
      const findings = await findingsWith({ 'apps/cli/package/dist/web/guard.d.ts': 'export {}\n' })

      // Assert
      expect(findings).toStrictEqual([
        "@log-book/cli: dist/web/guard.d.ts is outside the package's layout [package/layout]",
        '@log-book/cli: dist/web/guard.d.ts is a declaration file in the CLI [package/forbidden-path]',
      ])
    })
  })

  describe('the set', () => {
    it('fails on a package of the list that is not staged', async () => {
      // Act
      const findings = await findingsWith({
        'packages/core/package/package.json': null,
        'packages/core/package/README.md': null,
        'packages/core/package/LICENSE.md': null,
        'packages/core/package/dist/index.js': null,
        'packages/core/package/dist/index.d.ts': null,
      })

      // Assert
      expect(findings).toStrictEqual(['@log-book/core: packages/core/package is not staged [package/set]'])
    })

    it('fails on a publish order with the CLI first', async () => {
      // Act
      const findings = await findingsWith({
        'build/publish-order.txt': 'apps/cli/package\npackages/core/package\npackages/adapter-example/package\n',
      })

      // Assert
      expect(findings).toStrictEqual(['build/publish-order.txt: @log-book/cli is not last [package/publish-order]'])
    })

    it('fails on a library listed before a package it depends on', async () => {
      // Act
      const findings = await findingsWith({
        'build/publish-order.txt': 'packages/adapter-example/package\npackages/core/package\napps/cli/package\n',
      })

      // Assert
      expect(findings).toStrictEqual([
        'build/publish-order.txt: @log-book/adapter-example comes before @log-book/core, which it depends on ' +
          '[package/publish-order]',
      ])
    })
  })
})
