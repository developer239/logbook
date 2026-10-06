import { fileURLToPath } from 'node:url'
import { runSubprocess } from '@log-book/core'
import { describe, expect, it } from 'vitest'
import { parseAnchor } from './command.js'

// The entry loads the compiled command module, so it runs against the package's build.
const ENTRY = fileURLToPath(new URL('../bin/logbook-demo.mjs', import.meta.url))

describe('logbook-demo entry', () => {
  it.each([[[]], [['nope']]])('exits 2 with one line on stderr for the arguments %j', async (args) => {
    // Arrange
    const command = { command: process.execPath, args: [ENTRY, ...args], timeoutMs: 5000, label: 'logbook-demo' }

    // Act
    const result = await runSubprocess(command)

    // Assert
    expect({
      exitCode: result.exitCode,
      stdout: result.stdout,
      lines: result.stderr.trimEnd().split('\n').length,
    }).toStrictEqual({
      exitCode: 2,
      stdout: '',
      lines: 1,
    })
  })
})

describe('logbook-demo purity', () => {
  it("exits 0 and prints nothing when the generator's sources are pure", async () => {
    // Arrange
    const command = { command: process.execPath, args: [ENTRY, 'purity'], timeoutMs: 5000, label: 'logbook-demo' }

    // Act
    const result = await runSubprocess(command)

    // Assert
    expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' })
  })
})

describe('parseAnchor', () => {
  it('takes an ISO time with Z or an offset as the same instant, and now as the current hour', () => {
    // Arrange
    const now = Date.UTC(2026, 9, 5, 12, 34, 56)

    // Act
    const anchors = ['2026-09-28T18:00:00Z', '2026-09-28T20:00:00+02:00', 'now'].map((value) => parseAnchor(value, now))

    // Assert
    expect(anchors).toStrictEqual([Date.UTC(2026, 8, 28, 18), Date.UTC(2026, 8, 28, 18), Date.UTC(2026, 9, 5, 12)])
  })

  it('refuses a time without a zone, naming it', () => {
    // Act
    let refusal: unknown = null
    try {
      parseAnchor('2026-09-28T18:00:00', 0)
    } catch (error) {
      refusal = error
    }

    // Assert
    expect(refusal).toMatchObject({
      message: '--anchor takes an ISO time with Z or an offset, or now, got 2026-09-28T18:00:00',
    })
  })
})

describe('logbook-demo build', () => {
  it.each([
    [['--anchor', '2026-09-28T18:00:00']],
    [['--model', 'claude haiku']],
    [['--model', '-x']],
    [['--size', 'huge']],
    [['--seed', '-1']],
  ])('exits 2 with one line on stderr, before building, for %j', async (args) => {
    // Arrange
    const command = {
      command: process.execPath,
      args: [ENTRY, 'build', ...args],
      timeoutMs: 5000,
      label: 'logbook-demo',
    }

    // Act
    const result = await runSubprocess(command)

    // Assert
    expect({
      exitCode: result.exitCode,
      stdout: result.stdout,
      lines: result.stderr.trimEnd().split('\n').length,
    }).toStrictEqual({
      exitCode: 2,
      stdout: '',
      lines: 1,
    })
  })
})
