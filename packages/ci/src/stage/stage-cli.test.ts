import { execFile } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { gitWorkspaces } from '../testing/git-workspace.js'
import { cliManifest, stageCli } from './stage-cli.js'

const run = promisify(execFile)
const workspaces = gitWorkspaces()

const PUBLISHED = { description: 'Log Book shows where the time went.', homepage: 'https://example.com/logbook/' }

const WORKSPACE_MANIFEST = {
  name: '@log-book/cli',
  version: '0.0.0-development',
  private: true,
  bin: { logbook: 'bin/logbook.cjs' },
  engines: { node: '>=24' },
  os: ['darwin', 'linux'],
  scripts: { build: 'tsc -p tsconfig.build.json' },
}

// The CLI's built entry reads the web build's location from its own module, as the real one does.
const WEB_BUILD_SOURCE = "export const WEB_BUILD = new URL('../../web/dist/', import.meta.url)\n"
const CLI_SOURCE = ['import { WEB_BUILD } from', "'./web-build.js'", '\nprocess.stdout.write(WEB_BUILD.href)\n'].join(
  ' '
)

// The builds of a workspace, as small as the stage can take them.
const BUILDS: Readonly<Record<string, string>> = {
  'apps/cli/package.json': JSON.stringify(WORKSPACE_MANIFEST),
  'apps/cli/dist/cli.mjs': CLI_SOURCE,
  'apps/cli/dist/web-build.js': WEB_BUILD_SOURCE,
  'apps/cli/bin/logbook.cjs': "'use strict'\n",
  'packages/engine/dist/rewrite/rewrite-process.js': "process.stdout.write('rewrite')\n",
  'packages/engine/dist/prompts/example.prompt.txt': 'Label this.\n',
  'apps/web/dist/server/entry.mjs': 'export const handler = () => undefined\n',
  'apps/web/dist/client/fonts/Geist-OFL.txt': 'Open Font License\n',
  'apps/web/dist/guard.js': 'export const checkRequest = () => ({ isAccepted: true })\n',
  'apps/web/dist/guard.d.ts': 'export {}\n',
  'LICENSE.md': 'PolyForm Noncommercial 1.0.0\n',
  'README.md': `${PUBLISHED.description}\n\n![The dashboard](${PUBLISHED.homepage}captures/dashboard-dark.png)\n`,
  'apps/docs/site.ts': `export const SITE_URL = '${PUBLISHED.homepage}'\n`,
}

const STAGED = [
  'LICENSE.md',
  'README.md',
  'bin/logbook.cjs',
  'dist/cli.mjs',
  'dist/prompts/example.prompt.txt',
  'dist/rewrite-process.mjs',
  'dist/web/client/fonts/Geist-OFL.txt',
  'dist/web/guard.js',
  'dist/web/server/entry.mjs',
  'package.json',
]

const filesOf = async (directory: string): Promise<string[]> =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1))
    .toSorted()

afterEach(async () => {
  await workspaces.removeAll()
})

describe('cliManifest', () => {
  it('holds exactly the published fields, bin, engines and os from the workspace, keywords led by the harness ids', () => {
    // Act
    const manifest = cliManifest(WORKSPACE_MANIFEST, ['claude-code', 'opencode'], PUBLISHED)

    // Assert
    expect(manifest).toStrictEqual({
      name: '@log-book/cli',
      description: 'Log Book shows where the time went.',
      version: '0.0.0-development',
      license: 'PolyForm-Noncommercial-1.0.0',
      type: 'module',
      bin: { logbook: 'bin/logbook.cjs' },
      engines: { node: '>=24' },
      os: ['darwin', 'linux'],
      files: ['bin/', 'dist/', 'THIRD-PARTY-NOTICES.md'],
      homepage: 'https://example.com/logbook/',
      repository: { type: 'git', url: 'git+https://github.com/developer239/logbook.git', directory: 'apps/cli' },
      bugs: 'https://github.com/developer239/logbook/issues',
      keywords: ['claude-code', 'opencode', 'coding-agent', 'transcripts', 'analytics', 'local-first'],
      publishConfig: { access: 'public' },
    })
  })

  it('follows a raised Node floor', () => {
    // Act
    const manifest = cliManifest({ ...WORKSPACE_MANIFEST, engines: { node: '>=24.3' } }, [], PUBLISHED)

    // Assert
    expect(manifest).toMatchObject({ engines: { node: '>=24.3' } })
  })
})

describe('stageCli', () => {
  it('writes the package layout, with a bundle that finds the web build beside itself', async () => {
    // Arrange
    const root = await workspaces.create(BUILDS)

    // Act
    await stageCli(root)

    // Assert
    const staged = join(root, 'apps/cli/package')
    const { stdout } = await run(process.execPath, [join(staged, 'dist/cli.mjs')])
    expect({ files: await filesOf(staged), webBuild: stdout.endsWith('/apps/cli/package/dist/web/') }).toStrictEqual({
      files: STAGED,
      webBuild: true,
    })
  })

  it('carries the root README unchanged, and takes the description and homepage from it and the site', async () => {
    // Arrange
    const root = await workspaces.create(BUILDS)

    // Act
    await stageCli(root)

    // Assert
    const staged = join(root, 'apps/cli/package')
    const { description, homepage } = JSON.parse(await readFile(join(staged, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect({ readme: await readFile(join(staged, 'README.md'), 'utf8'), description, homepage }).toStrictEqual({
      readme: BUILDS['README.md'],
      ...PUBLISHED,
    })
  })

  it('leaves nothing of an earlier stage that the next one did not write', async () => {
    // Arrange
    const root = await workspaces.create(BUILDS)
    await stageCli(root)
    await writeFile(join(root, 'apps/cli/package/dist/old.mjs'), 'stale\n')

    // Act
    await stageCli(root)

    // Assert
    expect(await filesOf(join(root, 'apps/cli/package'))).toStrictEqual(STAGED)
  })

  it('refuses a workspace manifest without the fields the published one takes', async () => {
    // Arrange
    const root = await workspaces.create({ ...BUILDS, 'apps/cli/package.json': JSON.stringify({ name: 'x' }) })

    // Act
    const staging = stageCli(root)

    // Assert
    await expect(staging).rejects.toThrow('apps/cli/package.json needs bin and engines')
  })
})
