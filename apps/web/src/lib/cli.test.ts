import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { failureOf, runLogbook, type IChildRegistry } from './cli'
import { CliError } from './errors'
import { logbookStub, type ILogbookStub } from './testing/logbook-stub'

let directory = ''
let stub: ILogbookStub

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'web-cli-'))
  stub = await logbookStub(directory)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

describe('runLogbook', () => {
  it('passes an argument holding a space as one argument', async () => {
    // Act
    await runLogbook(['sync', 'two words'])

    // Assert
    expect(await stub.calls()).toStrictEqual([['sync', 'two words']])
  })

  it('keeps the last 20 lines of stderr, without the empty one after the final newline', async () => {
    // Arrange
    const lines = Array.from({ length: 50 }, (_, index) => `line ${String(index + 1)}`)
    stub.answer(1, lines)

    // Act
    const run = await runLogbook(['sync'])

    // Assert
    expect({ code: run.code, stderr: run.stderr }).toStrictEqual({ code: 1, stderr: lines.slice(-20) })
  })

  it('starts the child through the registry when the page has one', async () => {
    // Arrange
    const started: (readonly string[])[] = []
    const children: IChildRegistry = {
      spawn: (args) => {
        started.push(args)
        return spawn(process.execPath, [stub.path, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
      },
    }

    // Act
    await runLogbook(['sync'], children)

    // Assert
    expect({ started, calls: await stub.calls() }).toStrictEqual({ started: [['sync']], calls: [['sync']] })
  })

  it('refuses to write without LOGBOOK_CLI, and names a LOGBOOK_CLI that points at no file', async () => {
    // Arrange
    const missing = join(directory, 'missing.mjs')

    // Act
    vi.stubEnv('LOGBOOK_CLI', '')
    const unset = runLogbook(['sync'])
    await expect(unset).rejects.toThrow(
      new CliError(
        'Set LOGBOOK_CLI to the logbook entry script to write from here. logbook sets it itself; this is only needed under astro dev.'
      )
    )
    vi.stubEnv('LOGBOOK_CLI', missing)
    const absent = runLogbook(['sync'])

    // Assert
    await expect(absent).rejects.toThrow(new CliError(`No logbook entry at ${missing} (the path in LOGBOOK_CLI).`))
  })
})

describe('failureOf', () => {
  it('names the command and its last non-empty stderr line', () => {
    // Act
    const error = failureOf('sync', { code: 1, stdout: '', stderr: ['progress', 'disk full', ''] })

    // Assert
    expect(error.message).toBe('logbook sync failed: disk full')
  })
})
