import { afterEach, describe, expect, it } from 'vitest'
import { KNOWN_TOOL_NAMES, OWNER_LITERALS } from '../rules/owner-literals.js'
import { gitWorkspaces } from '../testing/git-workspace.js'
import { packageFindings } from './package.js'

const VERSION = '0.0.0-development'
const HOMEPAGE = 'https://example.com/logbook/'
const DESCRIPTION = 'Log Book shows where the time went.'
const REPOSITORY = 'git+https://github.com/developer239/logbook.git'
const BUGS = 'https://github.com/developer239/logbook/issues'
const INDEX = { types: './dist/index.d.ts', default: './dist/index.js' }
// A corpus mark of the right form, built here so this file holds no whole mark.
const MARK = `log-book-demo-corpus-${'0123456789abcdef'.repeat(2)}`
const SERVER_CHUNK = 'apps/cli/package/dist/web/server/chunks/page.mjs'
const ALLOWLIST = 'packages/ci/src/rules/licence-allowlist.ts'
const NO_OP_SERVICE =
  "Astro's image optimisation path: the web app's Astro configuration must keep the no-op image service " +
  '(passthroughImageService()), since the default one needs @img/* packages no user has installed [package/imports]'

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
  'apps/cli/build/metafile.json': json({
    inputs: { 'packages/core/dist/index.js': {}, 'node_modules/tiny/index.js': {} },
    outputs: {},
  }),
  'apps/cli/build/bundled-packages.json': json([
    { name: 'tiny', version: '1.0.0', license: 'MIT', licenseFile: 'node_modules/tiny/LICENSE' },
  ]),
  'apps/cli/package/THIRD-PARTY-NOTICES.md': 'The notices.\n\n## tiny 1.0.0\n\nLicense: MIT\n',
  'apps/cli/package/dist/web/server/entry.mjs': "import { page } from './chunks/page.mjs'\nexport { page }\n",
  [SERVER_CHUNK]: "import { readFile } from 'node:fs'\nconst path = require('path')\nexport const page = 1\n",
  'apps/cli/package/dist/web/client/fonts/Geist-Variable.woff2': 'a font\n',
  'apps/cli/package/dist/web/client/fonts/Geist-OFL.txt': 'Open Font License\n',
  'packages/demo/src/corpus/corpus-mark.json': json({ mark: MARK }),
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

  describe('bundle composition', () => {
    it.each([
      ['packages/demo/dist/index.js', 'the demo'],
      ['packages/warehouse/dist/testing/index.js', 'a /testing/ path'],
      ['packages/ci/dist/index.js', 'the CI tooling'],
    ])('fails on a metafile holding %s', async (input, what) => {
      // Act
      const findings = await findingsWith({
        'apps/cli/build/metafile.json': json({ inputs: { 'packages/core/dist/index.js': {}, [input]: {} } }),
      })

      // Assert
      expect(findings).toStrictEqual([`@log-book/cli: dist/cli.mjs bundles ${input}, ${what} [package/bundle]`])
    })

    it.each([
      ['GPL-3.0-only', false],
      ['(MIT OR Apache-2.0)', true],
      ['MIT AND GPL-3.0-only', false],
      ['(MIT AND ISC) OR GPL-3.0-only', true],
    ])('judges a bundled package licensed %s by the allowlist: allowed %s', async (license, isAllowed) => {
      // Act
      const findings = await findingsWith({
        'apps/cli/build/bundled-packages.json': json([
          { name: 'tiny', version: '1.0.0', license, licenseFile: 'node_modules/tiny/LICENSE' },
        ]),
      })

      // Assert
      expect(findings).toStrictEqual(
        isAllowed
          ? []
          : [
              `@log-book/cli: bundles tiny 1.0.0, licensed ${license}, which the allowlist in ${ALLOWLIST} does not ` +
                "hold; a new licence is the owner's decision [package/licence]",
            ]
      )
    })
  })

  describe('imports', () => {
    it.each([
      ['require', 'require("@img/sharp-libvips-dev/lib")'],
      ["a bundler's renamed require", '__require("@img/sharp-libvips-dev/lib")'],
    ])(
      'fails on a server chunk that requires the image path through %s, naming the no-op service',
      async (_how, call) => {
        // Act
        const findings = await findingsWith({ [SERVER_CHUNK]: `const libvips = ${call}\nexport const page = 1\n` })

        // Assert
        expect(findings).toStrictEqual([
          `@log-book/cli: dist/web/server/chunks/page.mjs imports @img/sharp-libvips-dev/lib, ${NO_OP_SERVICE}`,
        ])
      }
    )

    it('fails on a CLI file importing an npm package, and passes prose and templates that follow from', async () => {
      // Act
      const findings = await findingsWith({
        [SERVER_CHUNK]: [
          "import pad from 'left-pad'",
          '// tell "go on" from "stop after the batches in flight"',
          'const text = `Import \\`finalize\\` from \\`astro\\``',
          'export const page = pad',
          '',
        ].join('\n'),
      })

      // Assert
      expect(findings).toStrictEqual([
        '@log-book/cli: dist/web/server/chunks/page.mjs imports left-pad, which is neither relative nor a Node ' +
          'built-in [package/imports]',
      ])
    })

    it('fails on a library file importing an npm package', async () => {
      // Act
      const findings = await findingsWith({
        'packages/core/package/dist/index.js': `${importOf('pad', 'left-pad')}\nexport const core = pad\n`,
      })

      // Assert
      expect(findings).toStrictEqual([
        '@log-book/core: dist/index.js imports left-pad, which is neither relative, a Node built-in nor a @log-book/ ' +
          'package its manifest lists [package/imports]',
      ])
    })

    it('fails on a library file importing a @log-book package its manifest does not list', async () => {
      // Act
      const findings = await findingsWith({
        'packages/core/package/dist/index.js': `${importOf('adapter', '@log-book/adapter-example')}\nexport const core = 1\n`,
      })

      // Assert
      expect(findings).toStrictEqual([
        '@log-book/core: dist/index.js imports @log-book/adapter-example, which is neither relative, a Node ' +
          'built-in nor a @log-book/ package its manifest lists [package/imports]',
      ])
    })
  })

  describe('notices', () => {
    it('fails on a bundled package without a section in the notices', async () => {
      // Act
      const findings = await findingsWith({ 'apps/cli/package/THIRD-PARTY-NOTICES.md': 'The notices.\n' })

      // Assert
      expect(findings).toStrictEqual([
        '@log-book/cli: THIRD-PARTY-NOTICES.md has no section for tiny 1.0.0 [package/notices]',
      ])
    })

    it('fails on fonts without their licence beside them', async () => {
      // Act
      const findings = await findingsWith({ 'apps/cli/package/dist/web/client/fonts/Geist-OFL.txt': null })

      // Assert
      expect(findings).toStrictEqual([
        '@log-book/cli: dist/web/client/fonts/ holds fonts without Geist-OFL.txt [package/notices]',
      ])
    })
  })

  describe('content', () => {
    it('fails on a packed file holding the demo corpus mark', async () => {
      // Act
      const findings = await findingsWith({ 'packages/core/package/dist/index.js': `export const mark = '${MARK}'\n` })

      // Assert
      expect(findings).toStrictEqual(['@log-book/core: dist/index.js holds the demo corpus mark [package/corpus-mark]'])
    })

    it('passes the CI workspace path and fails on any other home path, naming it', async () => {
      // Act
      const findings = await findingsWith({
        [SERVER_CHUNK]: [
          "const built = '/home/runner/work/logbook/logbook/apps/web'",
          "const mac = '/Users/alex/work/logbook/apps/web'",
          "const linux = '/home/alex/logbook'",
          'export const page = [built, mac, linux]',
          '',
        ].join('\n'),
      })

      // Assert
      expect(findings).toStrictEqual([
        '@log-book/cli: dist/web/server/chunks/page.mjs holds the absolute home path /Users/alex/work/logbook/apps/web [package/home-path]',
        '@log-book/cli: dist/web/server/chunks/page.mjs holds the absolute home path /home/alex/logbook [package/home-path]',
      ])
    })

    it('fails on an owner literal, naming only the literal, and passes the known tool names', async () => {
      // Arrange
      const [literal = ''] = OWNER_LITERALS
      const [tool = ''] = KNOWN_TOOL_NAMES

      // Act
      const findings = await findingsWith({
        'packages/core/package/dist/index.js': `export const names = ['${tool}', 'my-${literal.toUpperCase()}-notes']\n`,
      })

      // Assert
      expect(findings).toStrictEqual([
        `@log-book/core: dist/index.js holds ${literal}, an owner-specific literal [package/owner-literal]`,
      ])
    })

    it('stops, naming the corpus directory, when its JSON files hold no corpus mark', async () => {
      // Act
      const findings = findingsWith({ 'packages/demo/src/corpus/corpus-mark.json': json({ mark: 'none' }) })

      // Assert
      await expect(findings).rejects.toThrow(
        "packages/demo/src/corpus: its JSON files hold 0 values of the corpus mark's form, not exactly one."
      )
    })
  })
})
