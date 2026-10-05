import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IAdapterEnvironment, IPrompt } from '@log-book/adapter-api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareCommands, resolveConfigDir, templatePrefix } from './commands.js'

const RELEASE = 'Release the project named in the arguments and report the version number it ships with: $ARGUMENTS'
const SHOP = 'work/shop'
const SUMMARY = 'Summarise the open changes in this project for the review.'

const writeCommand = async (directory: string, name: string, body: string): Promise<void> => {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${name}.md`), body)
}

const userPrompt = (text: string, projectDir: string | null = null): IPrompt => ({ actor: 'user', text, projectDir })

describe('templatePrefix', () => {
  it.each([
    ['$ARGUMENTS', `${SUMMARY} $ARGUMENTS and more`],
    ['$1', `${SUMMARY} $1 then $2`],
    ['!`', `${SUMMARY} !\`git status\``],
  ])('cuts a body at %s', (_placeholder, body) => {
    // Act
    const prefix = templatePrefix(body)

    // Assert
    expect(prefix).toBe(SUMMARY)
  })

  it('strips front matter and collapses whitespace', () => {
    // Act
    const prefix = templatePrefix(
      '---\ndescription: Release\nagent: build\n---\nRelease   the project\n\nnamed in the arguments and report the version: $ARGUMENTS'
    )

    // Assert
    expect(prefix).toBe('Release the project named in the arguments and report the version:')
  })

  it('gives a body shorter than 40 characters before its placeholder no template', () => {
    // Act
    const prefix = templatePrefix('Deploy $ARGUMENTS to staging and report the release number.')

    // Assert
    expect(prefix).toBeNull()
  })

  it('keeps at most 160 characters', () => {
    // Act
    const prefix = templatePrefix('word '.repeat(60))

    // Assert
    expect(prefix?.length).toBe(160)
  })
})

const configEnv = (variables: Record<string, string>): IAdapterEnvironment => ({
  variables,
  homeDir: '/home/example',
  cwd: '/home/example/work',
  platform: 'linux',
})

describe('resolveConfigDir', () => {
  it.each([
    [
      'OPENCODE_CONFIG_DIR absolute',
      { OPENCODE_CONFIG_DIR: '/srv/opencode-config', XDG_CONFIG_HOME: '/srv/xdg' },
      '/srv/opencode-config',
    ],
    [
      'OPENCODE_CONFIG_DIR relative, XDG_CONFIG_HOME absolute',
      { OPENCODE_CONFIG_DIR: 'config', XDG_CONFIG_HOME: '/srv/xdg' },
      '/srv/xdg/opencode',
    ],
    ['XDG_CONFIG_HOME relative', { XDG_CONFIG_HOME: 'xdg' }, '/home/example/.config/opencode'],
    ['no variable', {}, '/home/example/.config/opencode'],
  ])('resolves %s', (_case, variables, expected) => {
    // Act
    const directory = resolveConfigDir(configEnv(variables))

    // Assert
    expect(directory).toBe(expected)
  })
})

describe('prepareCommands', () => {
  let home = ''
  let env: IAdapterEnvironment = { variables: {}, homeDir: '', cwd: '', platform: 'linux' }

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'log-book-opencode-commands-')))
    env = { variables: {}, homeDir: home, cwd: home, platform: 'linux' }
    await writeCommand(join(home, '.config', 'opencode', 'commands'), 'release', RELEASE)
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('recognises a prompt that starts with a body, whitespace collapsed, and not one with only part of it', async () => {
    // Arrange
    const recogniser = await prepareCommands(env, [])

    // Act
    const answers = [
      recogniser.recognise(
        userPrompt('Release the project   named in the arguments\nand report the version number it ships with: shop')
      ),
      recogniser.recognise(userPrompt('Release the project named in the arguments')),
    ]

    // Assert
    expect(answers).toStrictEqual([{ command: 'release', source: 'template', hasFile: true }, null])
  })

  it("lets a project's file win over a global one of the same name, for that project only", async () => {
    // Arrange
    const projectBody = 'Release the shop to the store and post the release notes in the team channel: $ARGUMENTS'
    await writeCommand(join(home, SHOP, '.opencode', 'commands'), 'release', projectBody)
    const recogniser = await prepareCommands(env, [join(home, SHOP), join(home, 'work/billing')])
    const projectPrompt = 'Release the shop to the store and post the release notes in the team channel: 2.3.0'

    // Act
    const answers = [
      recogniser.recognise(userPrompt(projectPrompt, join(home, SHOP))),
      recogniser.recognise(userPrompt(projectPrompt, join(home, 'work/billing'))),
      recogniser.recognise(userPrompt(RELEASE.replace('$ARGUMENTS', 'shop'), join(home, SHOP))),
      recogniser.recognise(userPrompt(RELEASE.replace('$ARGUMENTS', 'billing'), join(home, 'work/billing'))),
    ]

    // Assert
    expect(answers).toStrictEqual([
      { command: 'release', source: 'template', hasFile: true },
      null,
      null,
      { command: 'release', source: 'template', hasFile: true },
    ])
  })

  it('takes the longer prefix when two commands match', async () => {
    // Arrange
    await writeCommand(
      join(home, '.config', 'opencode', 'commands'),
      'release-notes',
      'Release the project named in the arguments and report the version number it ships with, then write its notes: $ARGUMENTS'
    )
    const recogniser = await prepareCommands(env, [])

    // Act
    const answer = recogniser.recognise(
      userPrompt(
        'Release the project named in the arguments and report the version number it ships with, then write its notes: shop'
      )
    )

    // Assert
    expect(answer).toStrictEqual({ command: 'release-notes', source: 'template', hasFile: true })
  })

  it('reads the global directory under OPENCODE_CONFIG_DIR', async () => {
    // Arrange
    const configured = join(home, 'custom-config')
    await writeCommand(
      join(configured, 'commands'),
      'audit',
      'Audit the dependencies of this project for known vulnerabilities: $ARGUMENTS'
    )
    const recogniser = await prepareCommands({ ...env, variables: { OPENCODE_CONFIG_DIR: configured } }, [])

    // Act
    const answer = recogniser.recognise(
      userPrompt('Audit the dependencies of this project for known vulnerabilities: all')
    )

    // Assert
    expect(answer).toStrictEqual({ command: 'audit', source: 'template', hasFile: true })
  })

  it('returns null for a harness prompt and finds nothing in missing directories', async () => {
    // Arrange
    const recogniser = await prepareCommands({ ...env, homeDir: join(home, 'empty') }, [join(home, 'missing')])

    // Act
    const answers = [
      recogniser.recognise({ actor: 'harness', text: RELEASE.replace('$ARGUMENTS', 'shop'), projectDir: null }),
      recogniser.recognise(userPrompt(RELEASE.replace('$ARGUMENTS', 'shop'))),
    ]

    // Assert
    expect(answers).toStrictEqual([null, null])
  })
})
