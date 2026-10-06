import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitWorkspaces } from '../testing/git-workspace.js'
import { installPackages } from './installed.js'

// Packing and installing with the real npm, offline, takes a few seconds per package.
const NPM_TIMEOUT_MS = 60_000
const VERSION = '0.0.0-development'

const LIST = [
  {
    name: '@log-book/example-library',
    directory: 'packages/example-library',
    description: 'An example library',
    exports: ['.'],
    workspaceOnly: [],
    assets: [],
  },
  { name: '@log-book/cli', directory: 'apps/cli', description: '', exports: [], workspaceOnly: [], assets: [] },
]

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

// A staged library and a staged CLI as small as npm packs them, with the publish order naming both.
const stagedWorkspace = ({
  libraryExport = './dist/index.js',
  cliDependencies,
}: { libraryExport?: string; cliDependencies?: Record<string, string> } = {}): Record<string, string> => ({
  'packages/ci/src/rules/public-packages.json': JSON.stringify(LIST),
  'build/publish-order.txt': 'packages/example-library/package\napps/cli/package\n',
  'packages/example-library/package/package.json': json({
    name: '@log-book/example-library',
    version: VERSION,
    type: 'module',
    exports: { '.': libraryExport },
    files: ['dist/'],
  }),
  'packages/example-library/package/dist/index.js': 'export const example = 1\n',
  'apps/cli/package/package.json': json({
    name: '@log-book/cli',
    version: VERSION,
    bin: { logbook: 'bin/logbook.cjs' },
    files: ['bin/'],
    ...(cliDependencies === undefined ? {} : { dependencies: cliDependencies }),
  }),
  'apps/cli/package/bin/logbook.cjs': "#!/usr/bin/env node\nconsole.log(require('../package.json').version)\n",
})

const workspaces = gitWorkspaces()
const directories: string[] = []

const install = async (files: Record<string, string>): Promise<{ lines: string[]; bin: string }> => {
  const root = await workspaces.create(files)
  const directory = await mkdtemp(join(tmpdir(), 'installed-test-'))
  directories.push(directory)
  const lines: string[] = []
  const bin = await installPackages(root, directory, (line) => {
    lines.push(line)
  })
  return { lines, bin: bin.slice(directory.length) }
}

afterEach(async () => {
  await workspaces.removeAll()
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('installPackages', () => {
  it(
    'packs both, installs the CLI and runs it, and imports the library by name',
    async () => {
      // Act
      const installed = await install(stagedWorkspace())

      // Assert
      expect(installed).toStrictEqual({
        lines: [
          expect.stringMatching(/^Installed @log-book\/cli 0\.0\.0-development: .+\/bin\/logbook$/u) as string,
          'Imported @log-book/example-library',
        ],
        bin: '/prefix/bin/logbook',
      })
    },
    NPM_TIMEOUT_MS
  )

  it(
    'fails step 3 on a library whose export names a missing file, naming the package and the entry',
    async () => {
      // Act
      const installing = install(stagedWorkspace({ libraryExport: './dist/missing.js' }))

      // Assert
      await expect(installing).rejects.toThrow(
        /^step 3: @log-book\/example-library: @log-book\/example-library: .*Cannot find module/u
      )
    },
    NPM_TIMEOUT_MS
  )

  it(
    'fails step 2 on a CLI with a dependency, which installing offline cannot fetch',
    async () => {
      // Act
      const installing = install(stagedWorkspace({ cliDependencies: { 'log-book-example-absent': '1.0.0' } }))

      // Assert
      await expect(installing).rejects.toThrow(/^step 2: @log-book\/cli: /u)
    },
    NPM_TIMEOUT_MS
  )
})
