import { fileURLToPath } from 'node:url'
import { runSubprocess } from '@log-book/core'
import { describe, expect, it } from 'vitest'

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
