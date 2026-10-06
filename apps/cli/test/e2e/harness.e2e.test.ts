import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { lineDifferences, useE2eHarness, type IE2eHome } from './harness.js'

const run = promisify(execFile)
const harness = useE2eHarness()

// A stand-in for the logbook binary, run by this Node: it runs the given lines.
const standInBinary = async (home: IE2eHome, lines: readonly string[]): Promise<string> => {
  const file = join(home.out, 'stand-in-logbook')
  await writeFile(file, [`#!${process.execPath}`, ...lines, ''].join('\n'))
  await chmod(file, 0o755)
  return file
}

// A stand-in that leaves a file behind if it ever runs.
const witnessBinary = async (home: IE2eHome): Promise<{ ran: string }> => {
  const ran = join(home.out, 'ran')
  vi.stubEnv(
    'LOGBOOK_E2E_BIN',
    await standInBinary(home, [`require('node:fs').writeFileSync(${JSON.stringify(ran)}, '')`])
  )
  return { ran }
}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('the end-to-end harness', () => {
  describe('the isolated home', () => {
    it.each([
      ['HOME', { HOME: '/usr' }, 'HOME is /usr'],
      ['LOGBOOK_DB', { LOGBOOK_DB: '/usr/warehouse.db' }, 'LOGBOOK_DB is /usr/warehouse.db'],
    ])('refuses %s outside the OS temporary directory before any process starts', async (_name, change, named) => {
      // Arrange
      const home = await harness.createHome()
      const { ran } = await witnessBinary(home)

      // Act
      const running = harness.run({ ...home, environment: { ...home.environment, ...change } }, ['sync'])

      // Assert
      await expect(running).rejects.toThrow(`${named}, outside the OS temporary directory`)
      expect(existsSync(ran)).toBe(false)
    })

    it('runs the file LOGBOOK_E2E_BIN names directly, with exactly the sealed environment and the named variables', async () => {
      // Arrange
      const home = await harness.createHome()
      const firstOnPath = join(home.out, 'fakes')
      vi.stubEnv(
        'LOGBOOK_E2E_BIN',
        // macOS's CoreFoundation sets __CF_USER_TEXT_ENCODING inside every process that starts, this Node included,
        // so the stand-in leaves that one out of what it was given.
        await standInBinary(home, [
          "const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== '__CF_USER_TEXT_ENCODING'))",
          'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), env }))',
        ])
      )

      // Act
      const result = await harness.run(home, ['sync', '--quiet'], {
        env: { LOGBOOK_HOST_VERSION: '9.9.9', CLAUDE_CONFIG_DIR: join(home.out, 'claude') },
        firstOnPath,
      })

      // Assert
      expect({ code: result.code, printed: JSON.parse(result.stdout.join('\n')) as unknown }).toStrictEqual({
        code: 0,
        printed: {
          args: ['sync', '--quiet'],
          env: {
            HOME: join(home.out, 'home'),
            LOGBOOK_DB: join(home.out, 'warehouse.db'),
            PATH: `${firstOnPath}:/usr/bin:/bin`,
            TZ: 'UTC',
            LANG: 'C.UTF-8',
            LOGBOOK_HOST_VERSION: '9.9.9',
            CLAUDE_CONFIG_DIR: join(home.out, 'claude'),
          },
        },
      })
    })
  })

  describe('hosts', () => {
    it('refuses a host start with neither --no-open nor the stand-in opener before any process starts', async () => {
      // Arrange
      const home = await harness.createHome()
      const { ran } = await witnessBinary(home)

      // Act
      const starting = harness.startHost(home, { args: ['--no-sync'] })

      // Assert
      await expect(starting).rejects.toThrow(
        'a host start opens the browser; pass --no-open or install the stand-in opener'
      )
      expect(existsSync(ran)).toBe(false)
    })

    it('starts a host on an empty home that answers on the port its host file names, and stops it', async () => {
      // Arrange
      const home = await harness.createHome({ home: 'none' })

      // Act
      const host = await harness.startHost(home, { args: ['--no-open', '--no-sync'] })
      const response = await fetch(host.url)
      const code = await host.stop()

      // Assert
      expect({
        status: response.status,
        code,
        isHostFileLeft: existsSync(`${home.environment.LOGBOOK_DB ?? ''}.host`),
        isHostAlive: isProcessAlive(host.pid),
      }).toStrictEqual({ status: 200, code: 0, isHostFileLeft: false, isHostAlive: false })
    })
  })

  describe('the stand-in opener', () => {
    it('records its name, arguments and pid as open and as xdg-open, and exits with the chosen code', async () => {
      // Arrange
      const home = await harness.createHome()
      const opener = await harness.installOpener(home, { exitCode: 3 })

      // Act
      const codes = await Promise.all(
        ['open', 'xdg-open'].map(async (name) =>
          run(join(opener.directory, name), ['http://127.0.0.1:7314']).then(
            () => 0,
            (error: unknown) => (error as { code: number }).code
          )
        )
      )

      // Assert
      expect({
        codes,
        calls: (await opener.calls()).toSorted((left, right) => left.name.localeCompare(right.name)),
      }).toStrictEqual({
        codes: [3, 3],
        calls: [
          { name: 'open', args: ['http://127.0.0.1:7314'], pid: expect.any(Number) as number },
          { name: 'xdg-open', args: ['http://127.0.0.1:7314'], pid: expect.any(Number) as number },
        ],
      })
    })

    it('ends a stand-in opener the host left alive at the teardown', async () => {
      // Arrange
      const home = await harness.createHome()
      const opener = await harness.installOpener(home, 'stay-alive')
      const host = await harness.startHost(home, { args: ['--no-sync'], opener })
      const [call] = await vi.waitFor(async () => {
        const calls = await opener.calls()
        if (calls.length === 0) {
          throw new Error('logbook has not called the opener yet')
        }
        return calls
      })
      await host.stop()

      // Act
      await harness.teardown()

      // Assert
      expect({ args: call?.args, isOpenerAlive: isProcessAlive(call?.pid ?? 0) }).toStrictEqual({
        args: [host.url],
        isOpenerAlive: false,
      })
    })
  })

  describe('lineDifferences', () => {
    it.each([
      [
        '{duration}',
        ['Synced in 1.4 s', 'Synced in 31 s', 'Synced in 2 min', 'Synced in 2 min 10 s', 'Synced in 2 h 5 min'],
        'Synced in {duration}',
      ],
      ['{version}', ['Log Book 1.4.0', 'Log Book 0.0.0-development'], 'Log Book {version}'],
      ['{port}', ['Log Book is running at http://127.0.0.1:53124'], 'Log Book is running at http://127.0.0.1:{port}'],
      ['{size}', ['Warehouse 0 MB', 'Warehouse 1,261 MB', 'Warehouse 1.3 GB'], 'Warehouse {size}'],
    ])('accepts each form of %s', (_placeholder, lines, expected) => {
      // Act
      const differences = lines.flatMap((line) => lineDifferences([line], [expected]))

      // Assert
      expect(differences).toStrictEqual([])
    })

    it('fails on any other difference in a line, and on a missing or extra line', () => {
      // Act
      const differences = lineDifferences(
        ['Synced in 1.4 s.', 'Log Book 1.4', 'extra'],
        ['Synced in {duration}', 'Log Book {version}']
      )

      // Assert
      expect(differences).toStrictEqual([
        'line 1: expected "Synced in {duration}", got "Synced in 1.4 s."',
        'line 2: expected "Log Book {version}", got "Log Book 1.4"',
        'line 3: expected undefined, got "extra"',
      ])
    })
  })
})
