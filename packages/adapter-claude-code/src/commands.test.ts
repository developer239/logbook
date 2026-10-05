import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IAdapterEnvironment } from '@log-book/adapter-api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareCommands } from './commands.js'

const SHOP = '/home/example/work/shop'
const BILLING = '/home/example/work/billing'

const writeCommand = async (directory: string, name: string): Promise<string> => {
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${name}.md`)
  await writeFile(path, `Run ${name}.`)
  return path
}

describe('prepareCommands', () => {
  let root = ''
  let env: IAdapterEnvironment = { variables: {}, homeDir: '', cwd: '', platform: 'linux' }

  // The fixture home and the project directories below it, as the engine passes them.
  const projectDir = (dir: string): string => join(root, dir.slice(1))

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'log-book-claude-commands-')))
    env = { variables: {}, homeDir: root, cwd: root, platform: 'linux' }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  describe('with a global review command and a deploy command in shop', () => {
    beforeEach(async () => {
      await writeCommand(join(root, '.claude', 'commands'), 'review')
      await writeCommand(join(projectDir(SHOP), '.claude', 'commands'), 'deploy')
    })

    it.each([
      ['<command-name>/review</command-name>', BILLING, { command: 'review', source: 'typed', hasFile: true }],
      ['<command-name>/context</command-name>', SHOP, { command: 'context', source: 'typed', hasFile: false }],
      ['<command-name>/deploy</command-name>', SHOP, { command: 'deploy', source: 'typed', hasFile: true }],
      ['<command-name>/deploy</command-name>', BILLING, { command: 'deploy', source: 'typed', hasFile: false }],
      ['Please review the diff', SHOP, null],
      [
        'Run it now.\n<command-name>/review</command-name>',
        SHOP,
        { command: 'review', source: 'typed', hasFile: true },
      ],
      ['<command-name>  /review  </command-name>', SHOP, { command: 'review', source: 'typed', hasFile: true }],
      ['<command-name>review</command-name>', SHOP, { command: 'review', source: 'typed', hasFile: true }],
    ])('answers %j in %s', async (text, project, expected) => {
      // Arrange
      const recogniser = await prepareCommands(env, [projectDir(SHOP), projectDir(BILLING)])

      // Act
      const answer = recogniser.recognise({ actor: 'user', text, projectDir: projectDir(project) })

      // Assert
      expect(answer).toStrictEqual(expected)
    })

    it('answers a harness prompt, which is how Claude Code records a typed command', async () => {
      // Arrange
      const recogniser = await prepareCommands(env, [projectDir(SHOP)])

      // Act
      const answer = recogniser.recognise({
        actor: 'harness',
        text: '<command-name>/review</command-name>',
        projectDir: null,
      })

      // Assert
      expect(answer).toStrictEqual({ command: 'review', source: 'typed', hasFile: true })
    })
  })

  it('finds no file when the global and project directories are missing', async () => {
    // Arrange
    const recogniser = await prepareCommands(env, [projectDir(SHOP)])

    // Act
    const answer = recogniser.recognise({
      actor: 'user',
      text: '<command-name>/review</command-name>',
      projectDir: projectDir(SHOP),
    })

    // Assert
    expect(answer).toStrictEqual({ command: 'review', source: 'typed', hasFile: false })
  })

  it('reads the global directory under CLAUDE_CONFIG_DIR when it is set', async () => {
    // Arrange
    await writeCommand(join(root, 'config', 'commands'), 'ship')
    const configured = { ...env, variables: { CLAUDE_CONFIG_DIR: join(root, 'config') } }

    // Act
    const recogniser = await prepareCommands(configured, [])

    // Assert
    expect(
      recogniser.recognise({ actor: 'user', text: '<command-name>/ship</command-name>', projectDir: null })
    ).toStrictEqual({ command: 'ship', source: 'typed', hasFile: true })
  })

  it('counts a command file with mode 000 as existing, because its content is never read', async () => {
    // Arrange
    const path = await writeCommand(join(root, '.claude', 'commands'), 'locked')
    await chmod(path, 0o000)

    // Act
    const recogniser = await prepareCommands(env, [])

    // Assert
    expect(
      recogniser.recognise({ actor: 'user', text: '<command-name>/locked</command-name>', projectDir: null })
    ).toStrictEqual({ command: 'locked', source: 'typed', hasFile: true })
  })

  it('ignores skills and subdirectories', async () => {
    // Arrange
    await writeCommand(join(root, '.claude', 'skills'), 'testing')
    await mkdir(join(root, '.claude', 'commands', 'nested.md'), { recursive: true })

    // Act
    const recogniser = await prepareCommands(env, [])

    // Assert
    expect([
      recogniser.recognise({ actor: 'user', text: '<command-name>/testing</command-name>', projectDir: null }),
      recogniser.recognise({ actor: 'user', text: '<command-name>/nested</command-name>', projectDir: null }),
    ]).toStrictEqual([
      { command: 'testing', source: 'typed', hasFile: false },
      { command: 'nested', source: 'typed', hasFile: false },
    ])
  })
})
