import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteHostFile,
  HOST_PROBE_URL,
  hostFilePath,
  isLogBookAt,
  readHostFile,
  runningHost,
  writeHostFile,
  type IHostFile,
} from './host-file.js'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ALLOWLIST = join(REPOSITORY_ROOT, 'packages/engine/network-call-sites.json')
const OCTAL = 8
const PERMISSION_DIGITS = 3

let directory = ''
const servers: Server[] = []

// A server on a free loopback port that sets the Log Book header or not.
const serving = async (hasHeader: boolean): Promise<number> => {
  const server = createServer((_request, response) => {
    if (hasHeader) {
      response.setHeader('x-log-book', '1')
    }
    response.end('example')
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return (server.address() as AddressInfo).port
}

// A port nothing listens on: one a server held and gave back.
const closedPort = async (): Promise<number> => {
  const server = createServer()
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })
  return port
}

// The pid of a process that has ended.
const deadPid = (): number => {
  const { pid } = spawnSync(process.execPath, ['-e', ''])
  return pid
}

const host = (fields: Partial<IHostFile> = {}): IHostFile => ({
  pid: process.pid,
  port: 7314,
  version: '1.0.0',
  startedAt: 1_791_115_200_000,
  ...fields,
})

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cli-host-'))
})

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve()
          })
        })
    )
  )
  await rm(directory, { recursive: true, force: true })
})

describe('the host file', () => {
  it('sits next to the warehouse with the .host suffix', () => {
    // Act
    const path = hostFilePath('/tmp/example/warehouse.db')

    // Assert
    expect(path).toBe('/tmp/example/warehouse.db.host')
  })

  it('reads back the four fields it was written with, at mode 0600', async () => {
    // Arrange
    const path = join(directory, 'warehouse.db.host')

    // Act
    writeHostFile(path, host())

    // Assert
    expect({
      read: readHostFile(path),
      mode: (await stat(path)).mode.toString(OCTAL).slice(-PERMISSION_DIGITS),
      json: JSON.parse(await readFile(path, 'utf8')) as unknown,
    }).toStrictEqual({ read: host(), mode: '600', json: host() })
  })

  it('deletes the file, and a delete of a missing file does nothing', () => {
    // Arrange
    const path = join(directory, 'warehouse.db.host')
    writeHostFile(path, host())

    // Act
    deleteHostFile(path)
    deleteHostFile(path)

    // Assert
    expect(readHostFile(path)).toBeNull()
  })
})

describe('a running host', () => {
  it('runs with a live pid and a server answering with the header', async () => {
    // Arrange
    const path = join(directory, 'warehouse.db.host')
    const running = host({ port: await serving(true) })
    writeHostFile(path, running)

    // Act
    const found = await runningHost(path)

    // Assert
    expect(found).toStrictEqual(running)
  })

  it.each([
    ['no file', (): Promise<void> => Promise.resolve()],
    ['a file that does not parse', async (path: string): Promise<void> => writeFile(path, 'not json')],
    [
      'a dead pid',
      async (path: string): Promise<void> => {
        writeHostFile(path, host({ pid: deadPid(), port: await serving(true) }))
      },
    ],
    [
      'a live pid with a server without the header',
      async (path: string): Promise<void> => {
        writeHostFile(path, host({ port: await serving(false) }))
      },
    ],
    [
      'a live pid with nothing listening',
      async (path: string): Promise<void> => {
        writeHostFile(path, host({ port: await closedPort() }))
      },
    ],
  ])('does not run with %s', async (_case, arrange) => {
    // Arrange
    const path = join(directory, 'warehouse.db.host')
    await arrange(path)

    // Act
    const found = await runningHost(path)

    // Assert
    expect(found).toBeNull()
  })
})

describe('the port probe', () => {
  it('tells a Log Book host by its header from another program and from a closed port', async () => {
    // Arrange
    const ports = { logBook: await serving(true), other: await serving(false), closed: await closedPort() }

    // Act
    const answers = {
      logBook: await isLogBookAt(ports.logBook),
      other: await isLogBookAt(ports.other),
      closed: await isLogBookAt(ports.closed),
    }

    // Assert
    expect(answers).toStrictEqual({ logBook: true, other: false, closed: false })
  })

  it('is listed in the network allowlist as a local call site, by its own path', async () => {
    // Arrange
    const sites = JSON.parse(await readFile(ALLOWLIST, 'utf8')) as { file: string; case: string }[]
    const file = relative(REPOSITORY_ROOT, fileURLToPath(HOST_PROBE_URL))

    // Act
    const entries = sites.filter((site) => site.file === file).map((site) => site.case)

    // Assert
    expect(entries).toStrictEqual(['local'])
  })
})
