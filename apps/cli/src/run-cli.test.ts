import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogBookError } from '@log-book/core'
import { resolveWarehousePath, WAREHOUSE_ERROR_CODES, WarehouseStore, WarehouseVersionError } from '@log-book/warehouse'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMMANDS } from './grammar.js'
import { renderCommandHelp } from './help.js'
import { runCli, type CommandRunner } from './run-cli.js'
import { readOwnVersion } from './version.js'

interface IRun {
  code: number
  stdout: string
  stderr: string
}

const HOME = '/home/example'

const run = async (
  argv: readonly string[],
  runners: Readonly<Record<string, CommandRunner>> = {},
  env: Readonly<Record<string, string>> = {},
  signal: AbortSignal = new AbortController().signal
): Promise<IRun> => {
  let stdout = ''
  let stderr = ''
  const code = await runCli(
    {
      argv,
      env,
      home: HOME,
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      isStderrTty: false,
      signal,
    },
    runners
  )
  return { code, stdout, stderr }
}

const failing = (error: Error): CommandRunner => vi.fn<CommandRunner>().mockRejectedValue(error)

// Opens the warehouse, as sync does, so a test can show it was never reached.
const openingSync: CommandRunner = async () => {
  const store = await WarehouseStore.open(resolveWarehousePath())
  store.close()
  return 0
}

const lines = (text: string): string[] => text.split('\n').filter((line) => line.length > 0)

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runCli', () => {
  it.each(COMMANDS.map((command) => [command.words.join(' '), command] as const))(
    'prints the help of %s rendered from its table entry',
    async (words, command) => {
      // Act
      const result = await run([...words.split(' '), '--help'])

      // Assert
      expect(result).toStrictEqual({ code: 0, stdout: `${renderCommandHelp(command)}\n`, stderr: '' })
    }
  )

  it('lists the 17 commands in logbook --help, in table order', async () => {
    // Act
    const { code, stdout } = await run(['--help'])

    // Assert
    const listed = COMMANDS.map((command) => stdout.indexOf(command.synopsis.split('\n')[0] ?? ''))
    expect({ code, isListed: listed.every((at, index) => at >= 0 && at > (listed[index - 1] ?? -1)) }).toStrictEqual({
      code: 0,
      isListed: true,
    })
  })

  it('prints its version for --version', async () => {
    // Act
    const result = await run(['--version'])

    // Assert
    expect(result).toStrictEqual({ code: 0, stdout: `${await readOwnVersion()}\n`, stderr: '' })
  })

  it('prints a usage error as exactly one stderr line and exits 2', async () => {
    // Act
    const result = await run(['labels', 'verdict'])

    // Assert
    expect(result).toStrictEqual({
      code: 2,
      stdout: '',
      stderr: 'Unknown command: labels verdict. Run logbook --help for the commands.\n',
    })
  })

  it.each([
    [
      'a newer warehouse',
      new WarehouseVersionError('newer', WAREHOUSE_ERROR_CODES.WAREHOUSE_SCHEMA_NEWER, 3, 2),
      6,
      'The warehouse is at schema 3; this Log Book (VERSION) reads schema 2. Update with npm install -g @log-book/cli@latest.',
    ],
    [
      'a newer warehouse read only',
      new WarehouseVersionError('mismatch', WAREHOUSE_ERROR_CODES.WAREHOUSE_SCHEMA_MISMATCH, 3, 2),
      6,
      'The warehouse is at schema 3; this Log Book (VERSION) reads schema 2. Update with npm install -g @log-book/cli@latest.',
    ],
    [
      'an older warehouse read only',
      new WarehouseVersionError('mismatch', WAREHOUSE_ERROR_CODES.WAREHOUSE_SCHEMA_MISMATCH, 1, 2),
      1,
      'The warehouse is at schema 1; this Log Book (VERSION) reads schema 2. Run logbook sync or start logbook once to migrate it.',
    ],
    [
      'no warehouse yet',
      new LogBookError('No warehouse.', WAREHOUSE_ERROR_CODES.WAREHOUSE_NOT_FOUND),
      1,
      'No warehouse at ~/.local/share/log-book/warehouse.db yet. Run logbook sync or start logbook first.',
    ],
    ['any other error', new Error('The disk is full.'), 1, 'The disk is full.'],
  ])('ends a command that fails with %s with its exit code and line', async (_case, error, code, line) => {
    // Arrange
    vi.stubEnv('LOGBOOK_DB', join(HOME, '.local', 'share', 'log-book', 'warehouse.db'))
    const version = await readOwnVersion()

    // Act
    const result = await run(['sync'], { sync: failing(error) })

    // Assert
    expect(result).toStrictEqual({ code, stdout: '', stderr: `${line.replace('VERSION', version)}\n` })
  })

  it('prints the stack trace before the line with LOGBOOK_DEBUG=1, and none without it', async () => {
    // Arrange
    const runners = { sync: failing(new Error('The disk is full.')) }

    // Act
    const [debug, plain] = [await run(['sync'], runners, { LOGBOOK_DEBUG: '1' }), await run(['sync'], runners)]

    // Assert
    expect({
      debugLast: lines(debug.stderr).at(-1),
      hasTrace: lines(debug.stderr).length > 1 && debug.stderr.includes('    at '),
      plain: lines(plain.stderr),
    }).toStrictEqual({ debugLast: 'The disk is full.', hasTrace: true, plain: ['The disk is full.'] })
  })

  it('exits 130 when a one-shot command ends because it was aborted', async () => {
    // Arrange
    const controller = new AbortController()
    const { promise: started, resolve: start } = Promise.withResolvers<undefined>()
    const waiting: CommandRunner = async ({ io }) => {
      const aborted = new Promise((resolve) => {
        io.signal.addEventListener('abort', resolve)
      })
      start(undefined)
      await aborted
      throw new Error('Aborted.')
    }

    // Act
    const running = run(['compact'], { compact: waiting }, {}, controller.signal)
    await started
    controller.abort()

    // Assert
    expect((await running).code).toBe(130)
  })

  it('exits 9 for a host of another version before it opens the warehouse', async () => {
    // Arrange
    const directory = await mkdtemp(join(tmpdir(), 'cli-host-'))
    const missing = join(directory, 'missing')
    vi.stubEnv('LOGBOOK_DB', join(missing, 'warehouse.db'))

    try {
      // Act
      const result = await run(['sync'], { sync: openingSync }, { LOGBOOK_HOST_VERSION: '0.0.1' })

      // Assert
      expect({ ...result, isCreated: existsSync(missing) }).toStrictEqual({
        code: 9,
        stdout: '',
        stderr: 'Log Book was updated while running. Press Ctrl+C and start logbook again.\n',
        isCreated: false,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails a command this build has no runner for with a line saying so', async () => {
    // Act
    const result = await run(['doctor'])

    // Assert
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'logbook doctor is not in this build yet.\n' })
  })
})
