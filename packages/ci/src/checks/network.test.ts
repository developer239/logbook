import { afterEach, describe, expect, it } from 'vitest'
import { gitWorkspaces } from '../testing/git-workspace.js'
import { networkFindings } from './network.js'

const ALLOWLIST = 'packages/engine/network-call-sites.json'
const CLIENT = 'packages/engine/src/claude/client.ts'
const workspaces = gitWorkspaces()

const allowlist = (files: readonly string[]): string =>
  JSON.stringify(files.map((file) => ({ file, calls: 'example', case: 'local' })))

// A repository with an allowlist of these files, and these files.
const findingsFor = async (listed: readonly string[], files: Readonly<Record<string, string>>): Promise<string[]> =>
  networkFindings(await workspaces.create({ [ALLOWLIST]: allowlist(listed), ...files }))

afterEach(async () => {
  await workspaces.removeAll()
})

describe('the network call site check', () => {
  it('fails an unlisted file importing node:child_process, naming the file, the line and the module, and passes it listed', async () => {
    // Arrange
    const files = { [CLIENT]: "// The client\nimport { spawn } from 'node:child_process'\n" }

    // Act
    const [unlisted, listed] = [await findingsFor([], files), await findingsFor([CLIENT], files)]

    // Assert
    expect({ unlisted, listed }).toStrictEqual({
      unlisted: [`${CLIENT}:2: node:child_process is a call site ${ALLOWLIST} does not list [call-site]`],
      listed: [],
    })
  })

  it.each([
    ['apps/web/src/lib/ping.ts', "export const ping = async () => fetch('/ping')", 'fetch('],
    ['packages/core/src/get.ts', "const https = require('https')", 'https'],
    ['packages/warehouse/src/lookup.ts', "const dns = await import('node:dns')", 'node:dns'],
    ['apps/cli/src/socket.ts', "const socket = new WebSocket('ws://127.0.0.1')", 'WebSocket'],
    [
      'packages/engine/src/claude/run.ts',
      "const result = await runSubprocess({ command: 'claude' })",
      'runSubprocess(',
    ],
    ['apps/cli/bin/start.mjs', "export * from 'node:net'", 'node:net'],
  ])('fails an unlisted call site in %s', async (file, line, pattern) => {
    // Act
    const found = await findingsFor([], { [file]: `${line}\n` })

    // Assert
    expect(found).toStrictEqual([`${file}:1: ${pattern} is a call site ${ALLOWLIST} does not list [call-site]`])
  })

  it('passes the same lines in a test file, the testing subpath, the demo, CI and a type-only import', async () => {
    // Arrange
    const line = "import { spawn } from 'node:child_process'\nawait fetch('/ping')\n"

    // Act
    const found = await findingsFor([], {
      'packages/engine/src/claude/client.test.ts': line,
      'packages/engine/src/testing/record.ts': line,
      'packages/demo/src/start.ts': line,
      'packages/ci/src/run.ts': line,
      'apps/cli/src/host.ts': "import type { Server } from 'node:http'\n",
    })

    // Assert
    expect(found).toStrictEqual([])
  })

  it('fails an entry whose file has no call site, and one for a missing file', async () => {
    // Act
    const found = await findingsFor(['packages/warehouse/src/index.ts', 'packages/core/src/gone.ts'], {
      'packages/warehouse/src/index.ts': 'export const version = 1\n',
    })

    // Assert
    expect(found).toStrictEqual([
      `${ALLOWLIST}: the entry for packages/warehouse/src/index.ts names a file with no call site [stale-entry]`,
      `${ALLOWLIST}: the entry for packages/core/src/gone.ts names a missing file [stale-entry]`,
    ])
  })

  it('fails an allowlist that is not a list of entries', async () => {
    // Act
    const found = networkFindings(await workspaces.create({ [ALLOWLIST]: '{ "file": "x" }' }))

    // Assert
    await expect(found).resolves.toStrictEqual([`${ALLOWLIST}: not a list of entries, each with a file`])
  })
})
