import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitWorkspaces } from '../testing/git-workspace.js'
import { publishOrder, stageLibraries } from './stage-libraries.js'

const exportOf = (module: string): { types: string; default: string } => ({
  types: `./dist/${module}.d.ts`,
  default: `./dist/${module}.js`,
})

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
    name: '@log-book/engine',
    directory: 'packages/engine',
    description: 'The engine',
    exports: ['.'],
    workspaceOnly: ['./testing', './source-writer'],
    assets: ['dist/prompts/', 'dist/worker.js'],
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

// A workspace whose engine's public entry and testing entry share a module, whose source writer reaches a module of
// its own, which starts a worker by path and reads a prompt.
const WORKSPACE = {
  'LICENSE.md': 'The license\n',
  'packages/ci/src/rules/public-packages.json': JSON.stringify(LIST),
  'packages/core/package.json': JSON.stringify({ name: '@log-book/core', exports: { '.': exportOf('index') } }),
  'packages/core/dist/index.js': 'export const core = 1\n',
  'packages/core/dist/index.d.ts': 'export declare const core = 1\n',
  'packages/engine/package.json': JSON.stringify({
    name: '@log-book/engine',
    exports: {
      '.': exportOf('index'),
      './testing': exportOf('testing/index'),
      './source-writer': exportOf('source-writer/index'),
    },
    dependencies: { '@log-book/core': 'workspace:*' },
    devDependencies: { '@log-book/demo': 'workspace:*', 'vitest': '5.0.0' },
  }),
  'packages/engine/dist/index.js':
    "export { shared } from './shared.js'\nimport versions from './versions.json' with { type: 'json' }\n",
  'packages/engine/dist/index.d.ts': "export { shared } from './shared.js'\n",
  'packages/engine/dist/shared.js': 'export const shared = 1\n',
  'packages/engine/dist/shared.d.ts': 'export declare const shared = 1\n',
  'packages/engine/dist/versions.json': '{ "shell": 1 }\n',
  'packages/engine/dist/testing/index.js': "export { shared } from '../shared.js'\n",
  'packages/engine/dist/testing/index.d.ts': "export { shared } from '../shared.js'\n",
  'packages/engine/dist/source-writer/index.js': "export { write } from './writer.js'\n",
  'packages/engine/dist/source-writer/writer.js': 'export const write = 1\n',
  'packages/engine/dist/worker.js': "import { step } from './worker-step.js'\n",
  'packages/engine/dist/worker-step.js': 'export const step = 1\n',
  'packages/engine/dist/prompts/shell.prompt.txt': 'Label the call.\n',
}
const workspaces = gitWorkspaces()

const filesIn = async (directory: string): Promise<string[]> =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1))
    .toSorted()

afterEach(async () => {
  await workspaces.removeAll()
})

describe('stageLibraries', () => {
  it('stages what the public entry reaches, a shared module but no testing or source-writer file, and the assets', async () => {
    // Arrange
    const root = await workspaces.create(WORKSPACE)

    // Act
    await stageLibraries(root)

    // Assert
    expect(await filesIn(join(root, 'packages/engine/package'))).toStrictEqual([
      'LICENSE.md',
      'README.md',
      'dist/index.d.ts',
      'dist/index.js',
      'dist/prompts/shell.prompt.txt',
      'dist/shared.d.ts',
      'dist/shared.js',
      'dist/versions.json',
      'dist/worker-step.js',
      'dist/worker.js',
      'package.json',
    ])
  })

  it('writes exactly the published fields, with the workspace @log-book dependencies at the set version', async () => {
    // Arrange
    const root = await workspaces.create(WORKSPACE)

    // Act
    await stageLibraries(root)

    // Assert
    expect(JSON.parse(await readFile(join(root, 'packages/engine/package/package.json'), 'utf8'))).toStrictEqual({
      name: '@log-book/engine',
      description: 'The engine',
      version: '0.0.0-development',
      license: 'PolyForm-Noncommercial-1.0.0',
      type: 'module',
      engines: { node: '>=24' },
      exports: { '.': exportOf('index') },
      files: ['dist/'],
      repository: {
        type: 'git',
        url: 'git+https://github.com/developer239/logbook.git',
        directory: 'packages/engine',
      },
      bugs: 'https://github.com/developer239/logbook/issues',
      publishConfig: { access: 'public' },
      dependencies: { '@log-book/core': '0.0.0-development' },
    })
  })

  it('writes the publish order with the libraries before the CLI', async () => {
    // Arrange
    const root = await workspaces.create(WORKSPACE)

    // Act
    await stageLibraries(root)

    // Assert
    expect(await readFile(join(root, 'build/publish-order.txt'), 'utf8')).toBe(
      'packages/core/package\npackages/engine/package\napps/cli/package\n'
    )
  })
})

describe('publishOrder', () => {
  it('puts dependencies first, ties in name order and the CLI last', () => {
    // Act
    const order = publishOrder(
      [
        {
          name: '@log-book/engine',
          directory: 'packages/engine',
          dependsOn: ['@log-book/core', '@log-book/warehouse'],
        },
        { name: '@log-book/warehouse', directory: 'packages/warehouse', dependsOn: ['@log-book/core'] },
        { name: '@log-book/adapter-api', directory: 'packages/adapter-api', dependsOn: ['@log-book/core'] },
        { name: '@log-book/core', directory: 'packages/core', dependsOn: [] },
      ],
      'apps/cli'
    )

    // Assert
    expect(order).toStrictEqual([
      'packages/core/package',
      'packages/adapter-api/package',
      'packages/warehouse/package',
      'packages/engine/package',
      'apps/cli/package',
    ])
  })

  it('stops on a cycle, naming its packages', () => {
    expect(() =>
      publishOrder(
        [
          { name: '@log-book/a', directory: 'packages/a', dependsOn: ['@log-book/b'] },
          { name: '@log-book/b', directory: 'packages/b', dependsOn: ['@log-book/a'] },
        ],
        'apps/cli'
      )
    ).toThrow('These packages depend on each other in a cycle: @log-book/a, @log-book/b.')
  })
})
