import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitWorkspaces } from '../testing/git-workspace.js'
import { BUNDLED_PACKAGES, LICENCE_TEXTS, NOTICES, writeThirdParty } from './third-party.js'

const workspaces = gitWorkspaces()

afterEach(async () => {
  await workspaces.removeAll()
})

const ALPHA = 'node_modules/.pnpm/alpha@1.0.0/node_modules/alpha'
const ZETA = 'node_modules/.pnpm/@example+zeta@2.0.0/node_modules/@example/zeta'
const BARE = 'node_modules/.pnpm/bare@3.1.0/node_modules/bare'
const ALPHA_LICENCE =
  'MIT License\n\nCopyright (c) Example Author\n\nPermission is hereby granted, `inline` and\n```\nfenced\n```\n'
const ZETA_LICENCE = 'ISC License\n\nCopyright (c) Another Author\n'
const CHOSEN_LICENCE = 'ISC License\n\nCopyright (c) Bare Author\n'
const HEADER = "Log Book's package includes the following npm packages, each under its own licence.\n\n"

const json = (value: unknown): string => JSON.stringify(value)

const manifest = (name: string, version: string, license: string): string => json({ name, version, license })

// A workspace whose CLI bundle inlined alpha and Log Book's core, and whose web build inlined alpha and zeta.
const workspace = (extra: Readonly<Record<string, string>> = {}): Record<string, string> => ({
  'apps/cli/build/metafile.json': json({
    inputs: {
      [`${ALPHA}/index.js`]: {},
      'packages/engine/dist/index.js': {},
      'node_modules/@log-book/core/dist/index.js': {},
    },
  }),
  'apps/web/build/modules.json': json({ server: [`${ALPHA}/index.js`, `${ZETA}/dist/server.js`], client: [] }),
  [`${ALPHA}/package.json`]: manifest('alpha', '1.0.0', 'MIT'),
  [`${ALPHA}/LICENSE`]: ALPHA_LICENCE,
  [`${ALPHA}/index.js`]: 'export const alpha = 1\n',
  [`${ZETA}/package.json`]: manifest('@example/zeta', '2.0.0', 'ISC'),
  [`${ZETA}/license.md`]: ZETA_LICENCE,
  [`${ZETA}/dist/server.js`]: 'export const zeta = 1\n',
  'node_modules/@log-book/core/package.json': manifest('@log-book/core', '0.0.0-development', 'PolyForm'),
  [LICENCE_TEXTS]: '{}',
  'apps/cli/package/package.json': '{}',
  ...extra,
})

// The same workspace with bare, which ships no licence file, inlined into the web build too.
const withBare = (extra: Readonly<Record<string, string>>): Record<string, string> =>
  workspace({
    'apps/web/build/modules.json': json({
      server: [`${ALPHA}/index.js`, `${ZETA}/dist/server.js`],
      client: [`${BARE}/a.js`],
    }),
    [`${BARE}/package.json`]: manifest('bare', '3.1.0', 'ISC'),
    [`${BARE}/a.js`]: 'export const bare = 1\n',
    ...extra,
  })

const written = async (root: string): Promise<{ list: unknown; notices: string }> => ({
  list: JSON.parse(await readFile(join(root, BUNDLED_PACKAGES), 'utf8')) as unknown,
  notices: await readFile(join(root, NOTICES), 'utf8'),
})

describe('writeThirdParty', () => {
  it('lists a package of both sources once, in name order, each with its licence text unchanged', async () => {
    // Arrange
    const root = await workspaces.create(workspace())

    // Act
    await writeThirdParty(root)

    // Assert
    expect(await written(root)).toStrictEqual({
      list: [
        { name: '@example/zeta', version: '2.0.0', license: 'ISC', licenseFile: `${ZETA}/license.md` },
        { name: 'alpha', version: '1.0.0', license: 'MIT', licenseFile: `${ALPHA}/LICENSE` },
      ],
      notices: [
        HEADER,
        `## @example/zeta 2.0.0\n\nLicense: ISC\n\n\`\`\`text\n${ZETA_LICENCE.trimEnd()}\n\`\`\`\n\n`,
        `## alpha 1.0.0\n\nLicense: MIT\n\n\`\`\`\`text\n${ALPHA_LICENCE.trimEnd()}\n\`\`\`\`\n`,
      ].join(''),
    })
  })

  it('lists no @log-book/ package, from either source', async () => {
    // Arrange
    const root = await workspaces.create(
      workspace({
        'apps/web/build/modules.json': json({ server: ['node_modules/@log-book/core/dist/index.js'], client: [] }),
      })
    )

    // Act
    await writeThirdParty(root)

    // Assert
    const { list, notices } = await written(root)
    expect({
      names: (list as { name: string }[]).map(({ name }) => name),
      isNamed: notices.includes('@log-book/'),
    }).toStrictEqual({ names: ['alpha'], isNamed: false })
  })

  it('stops on a package without a licence file, naming it, when no text is recorded for that version', async () => {
    // Arrange
    const root = await workspaces.create(
      withBare({
        [LICENCE_TEXTS]: json({ 'bare@3.0.0': { license: 'ISC', file: 'licences/bare@3.0.0.txt' } }),
      })
    )

    // Act
    const writing = writeThirdParty(root)

    // Assert
    await expect(writing).rejects.toThrow(
      `bare 3.1.0 ships no licence file, and ${LICENCE_TEXTS} records no text for it.`
    )
  })

  it('ships the text recorded for a package without a licence file, saying so', async () => {
    // Arrange
    const root = await workspaces.create(
      withBare({
        [LICENCE_TEXTS]: json({ 'bare@3.1.0': { license: 'ISC', file: 'licences/bare@3.1.0.txt' } }),
        'packages/ci/src/rules/licences/bare@3.1.0.txt': CHOSEN_LICENCE,
      })
    )

    // Act
    await writeThirdParty(root)

    // Assert
    const { list, notices } = await written(root)
    expect({
      entry: (list as { name: string }[]).find(({ name }) => name === 'bare'),
      section: notices.slice(notices.indexOf('## bare')),
    }).toStrictEqual({
      entry: {
        name: 'bare',
        version: '3.1.0',
        license: 'ISC',
        licenseFile: 'packages/ci/src/rules/licences/bare@3.1.0.txt',
      },
      section:
        '## bare 3.1.0\n\nLicense: ISC\n\nbare ships no licence file. The text below is the standard text of the ' +
        'licence its package.json declares, with its author as the copyright holder.\n\n```text\n' +
        `${CHOSEN_LICENCE.trimEnd()}\n\`\`\`\n`,
    })
  })

  it('stops on a recorded text whose licence is not the one the package declares', async () => {
    // Arrange
    const root = await workspaces.create(
      withBare({
        [LICENCE_TEXTS]: json({ 'bare@3.1.0': { license: 'MIT', file: 'licences/bare@3.1.0.txt' } }),
        'packages/ci/src/rules/licences/bare@3.1.0.txt': CHOSEN_LICENCE,
      })
    )

    // Act
    const writing = writeThirdParty(root)

    // Assert
    await expect(writing).rejects.toThrow(
      `${LICENCE_TEXTS} records MIT for bare 3.1.0, whose package.json declares ISC.`
    )
  })
})
