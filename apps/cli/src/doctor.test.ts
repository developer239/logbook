import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import type { IAdapterEnvironment } from '@log-book/adapter-api'
import { inventedAdapter } from '@log-book/adapter-api/testing'
import type { ClaudeDetection } from '@log-book/engine'
import { createTestWarehouse, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDoctorRunner, type IDoctorSources } from './doctor.js'
import { hostFilePath, writeHostFile } from './host-file.js'
import { runCli } from './run-cli.js'
import { readOwnVersion } from './version.js'

interface IRun {
  code: number
  stdout: string
  stderr: string
}

const HOME = '/home/example'
const MISSING: ClaudeDetection = { status: 'missing', missing: { kind: 'not-found', variable: null } }

const environment = (): IAdapterEnvironment => ({ variables: {}, homeDir: HOME, cwd: HOME, platform: 'linux' })

const SOURCES: IDoctorSources = {
  adapters: [inventedAdapter({ name: 'Example Agent', locate: { kind: 'found', root: '.example' } })],
  environment,
  detect: vi.fn<IDoctorSources['detect']>().mockResolvedValue(MISSING),
}

let warehouse: ITestWarehouse
let server: Server | null = null

const doctor = async (): Promise<IRun> => {
  let stdout = ''
  let stderr = ''
  const code = await runCli(
    {
      argv: ['doctor'],
      env: {},
      home: HOME,
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      isStderrTty: false,
      signal: new AbortController().signal,
    },
    { doctor: createDoctorRunner(SOURCES) }
  )
  return { code, stdout, stderr }
}

// The block with its warehouse line in place, the other lines as this test's sources give them.
const block = async (warehouseLine: string): Promise<string> =>
  [
    `Log Book ${await readOwnVersion()}, Node.js ${process.versions.node}, ${process.platform} ${process.arch}`,
    warehouseLine,
    'Example Agent found at ~/.example',
    'Labelling   needs Claude Code: install it (https://claude.com/claude-code) or set CLAUDE_BIN',
    '',
  ].join('\n')

const serveLogBook = async (): Promise<number> => {
  server = createServer((_request, response) => {
    response.setHeader('x-log-book', '1')
    response.end()
  })
  const listening = server
  await new Promise<void>((resolve) => {
    listening.listen(0, '127.0.0.1', resolve)
  })
  return (listening.address() as AddressInfo).port
}

beforeEach(async () => {
  warehouse = await createTestWarehouse()
  vi.stubEnv('LOGBOOK_DB', warehouse.path)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  const closing = server
  server = null
  if (closing !== null) {
    await new Promise<void>((resolve) => {
      closing.close(() => {
        resolve()
      })
    })
  }
  await warehouse.remove()
})

describe('logbook doctor', () => {
  it("reports a warehouse at the build's schema with no host running, exits 0 and creates nothing", async () => {
    // Arrange
    const before = await readdir(dirname(warehouse.path))

    // Act
    const result = await doctor()

    // Assert
    expect(result).toStrictEqual({
      code: 0,
      stdout: await block(`Warehouse   ${warehouse.path} (schema 1, 0 MB; no host running)`),
      stderr: '',
    })
    expect(await readdir(dirname(warehouse.path))).toStrictEqual(before)
  })

  it.each([
    ['older', 0],
    ['newer', 99],
  ])('reports an %s schema without refusing or migrating it', async (_case, version) => {
    // Arrange
    warehouse.db.exec(`PRAGMA user_version = ${String(version)}`)

    // Act
    const result = await doctor()

    // Assert
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(
      await block(`Warehouse   ${warehouse.path} (schema ${String(version)}, 0 MB; no host running)`)
    )
  })

  it('reports a missing warehouse as not created yet, and creates neither it nor its directory', async () => {
    // Arrange
    const missing = join(dirname(warehouse.path), 'missing', 'warehouse.db')
    vi.stubEnv('LOGBOOK_DB', missing)

    // Act
    const result = await doctor()

    // Assert
    expect(result).toStrictEqual({
      code: 0,
      stdout: await block(`Warehouse   ${missing} (not created yet)`),
      stderr: '',
    })
    expect(existsSync(dirname(missing))).toBe(false)
  })

  it('names the port of a running host', async () => {
    // Arrange
    const port = await serveLogBook()
    writeHostFile(hostFilePath(warehouse.path), { pid: process.pid, port, version: '1.0.0', startedAt: 1 })

    // Act
    const result = await doctor()

    // Assert
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(
      await block(`Warehouse   ${warehouse.path} (schema 1, 0 MB; host running at http://127.0.0.1:${String(port)})`)
    )
  })
})
