import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WarehouseStore } from '@log-book/warehouse'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IChildRegistry } from './child-registry.js'
import { errorReport } from './errors.js'
import { hostFilePath, writeHostFile } from './host-file.js'
import {
  bindHost,
  createHostRunner,
  findRunningHost,
  startHost,
  waitForStop,
  type IHostSources,
  type IServing,
  type IStartSteps,
} from './host.js'

const PATHS = { warehousePath: '/home/example/warehouse.db', dataDirectory: '/home/example' }
const OPENED = { path: PATHS.warehousePath, previousVersion: 0, version: 1 }

const SERVING: IServing = { port: 7314, stop: async () => Promise.resolve(), kill: () => undefined }
// A pid no process has.
const DEAD_PID = 999_999

// Stand-ins for the steps; each records its call. `runningPort` is the port of a host already on the warehouse.
const recordingSteps = (calls: string[], runningPort: number | null = null): IStartSteps => ({
  resolvePaths: () => {
    calls.push('resolvePaths')
    return PATHS
  },
  findRunningHost: async () => {
    calls.push('findRunningHost')
    return Promise.resolve(runningPort)
  },
  migrate: async () => {
    calls.push('migrate')
    return Promise.resolve(OPENED)
  },
  announce: async () => {
    calls.push('announce')
    return Promise.resolve()
  },
  serve: async () => {
    calls.push('serve')
    return Promise.resolve(SERVING)
  },
  recordHost: () => {
    calls.push('recordHost')
  },
  open: (port) => {
    calls.push(`open ${String(port)}`)
  },
  detect: () => {
    calls.push('detect')
  },
  sync: () => {
    calls.push('sync')
  },
})

// Signals the test sends by hand.
const handSignals = (): {
  send: () => void
  listeners: () => number
  signals: (listener: () => void) => () => void
} => {
  const listeners = new Set<() => void>()
  return {
    send: () => {
      for (const listener of listeners) {
        listener()
      }
    },
    listeners: () => listeners.size,
    signals: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

describe('startHost', () => {
  it('runs the steps in the order of the start sequence, opening the warehouse first at step 4', async () => {
    // Arrange
    const calls: string[] = []

    // Act
    await startHost(recordingSteps(calls))

    // Assert
    expect(calls).toStrictEqual([
      'resolvePaths',
      'findRunningHost',
      'migrate',
      'announce',
      'serve',
      'recordHost',
      'open 7314',
      'detect',
      'sync',
    ])
  })

  it('stops after the one-host check when a host runs on the warehouse, opening its page, before anything opens the warehouse', async () => {
    // Arrange
    const calls: string[] = []

    // Act
    const outcome = await startHost(recordingSteps(calls, 7314))

    // Assert
    expect({ outcome, calls }).toStrictEqual({
      outcome: { kind: 'already running', port: 7314 },
      calls: ['resolvePaths', 'findRunningHost', 'open 7314'],
    })
  })
})

describe('waitForStop', () => {
  it('stops the host on the first stop signal, and exits 0 once it has stopped', async () => {
    // Arrange
    const events: string[] = []
    const { promise: stopped, resolve: finishStop } = Promise.withResolvers<undefined>()
    const serving: IServing = {
      port: 7314,
      stop: async () => {
        events.push('stop')
        await stopped
      },
      kill: () => events.push('kill'),
    }
    const hand = handSignals()
    const waiting = waitForStop(serving, hand.signals)

    // Act
    hand.send()
    finishStop(undefined)
    const code = await waiting

    // Assert
    expect({ code, events, listeners: hand.listeners() }).toStrictEqual({ code: 0, events: ['stop'], listeners: 0 })
  })

  it('kills the children and exits 0 at once on a second stop signal while stopping', async () => {
    // Arrange
    const events: string[] = []
    const serving: IServing = {
      port: 7314,
      stop: async () => {
        events.push('stop')
        return new Promise(() => undefined)
      },
      kill: () => events.push('kill'),
    }
    const hand = handSignals()
    const waiting = waitForStop(serving, hand.signals)

    // Act
    hand.send()
    hand.send()
    const code = await waiting

    // Assert
    expect({ code, events, listeners: hand.listeners() }).toStrictEqual({
      code: 0,
      events: ['stop', 'kill'],
      listeners: 0,
    })
  })
})

const servers: Server[] = []
let directory = ''

// A server on a port the system picks, answering with the Log Book header or without it.
const serverOnPort = async (isLogBook: boolean): Promise<number> => {
  const server = createServer((_req, res) => {
    res.writeHead(200, isLogBook ? { 'x-log-book': '0.0.0-development' } : {})
    res.end()
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return (server.address() as AddressInfo).port
}

// A source the runner must not reach.
const refuse = async (): Promise<never> => Promise.reject(new Error('not reached'))

const warehouseIn = async (): Promise<string> => {
  directory = await mkdtemp(join(tmpdir(), 'host-one-'))
  return join(directory, 'warehouse.db')
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        new Promise((resolve) => {
          server.close(resolve)
        })
    )
  )
  if (directory !== '') {
    await rm(directory, { recursive: true, force: true })
    directory = ''
  }
})

describe('findRunningHost', () => {
  it('names the port of a host that runs on the warehouse: its pid lives and its port answers as Log Book', async () => {
    // Arrange
    const warehouse = await warehouseIn()
    const port = await serverOnPort(true)
    writeHostFile(hostFilePath(warehouse), { pid: process.pid, port, version: '0.0.0-development', startedAt: 1 })

    // Act
    const found = await findRunningHost(warehouse)

    // Assert
    expect(found).toBe(port)
  })

  it('takes a host file whose pid is gone, or whose port answers without the header, as stale', async () => {
    // Arrange
    const [dead, other] = [await warehouseIn(), join(directory, 'other.db')]
    const logBookPort = await serverOnPort(true)
    const otherPort = await serverOnPort(false)
    writeHostFile(hostFilePath(dead), { pid: DEAD_PID, port: logBookPort, version: '0.0.0-development', startedAt: 1 })
    writeHostFile(hostFilePath(other), {
      pid: process.pid,
      port: otherPort,
      version: '0.0.0-development',
      startedAt: 1,
    })

    // Act
    const found = [await findRunningHost(dead), await findRunningHost(other)]

    // Assert
    expect(found).toStrictEqual([null, null])
  })

  it('finds no host where there is no host file', async () => {
    // Act
    const found = await findRunningHost(await warehouseIn())

    // Assert
    expect(found).toBeNull()
  })
})

describe('the host runner on a warehouse a host already serves', () => {
  it.each([
    [{}, true],
    [{ 'no-open': true }, false],
  ])(
    'prints the running host, opens its page unless --no-open (%o), and exits 0 without opening the warehouse',
    async (flags, isOpened) => {
      // Arrange
      const warehouse = await warehouseIn()
      const port = await serverOnPort(true)
      writeHostFile(hostFilePath(warehouse), { pid: process.pid, port, version: '0.0.0-development', startedAt: 1 })
      vi.stubEnv('LOGBOOK_DB', warehouse)
      const opened: string[] = []
      const pages: string[] = []
      const sources: IHostSources = {
        openWarehouse: async (path) => {
          opened.push(path)
          return refuse()
        },
        environment: () => {
          throw new Error('not reached')
        },
        loadWebApp: refuse,
        detect: refuse,
        createRegistry: () => {
          throw new Error('not reached')
        },
        openBrowser: (url) => {
          pages.push(url)
        },
        signals: () => () => undefined,
      }
      let stdout = ''

      // Act
      const code = await createHostRunner(sources)({
        command: 'start',
        values: { port: 0, ...flags },
        positionals: [],
        version: '0.0.0-development',
        io: {
          argv: [],
          env: {},
          home: '/home/example',
          stdout: (text) => {
            stdout += text
          },
          stderr: () => undefined,
          isStderrTty: false,
          signal: new AbortController().signal,
        },
      })

      // Assert
      expect({ code, stdout, opened, pages }).toStrictEqual({
        code: 0,
        stdout: `Log Book is already running at http://127.0.0.1:${String(port)}\n`,
        opened: [],
        pages: isOpened ? [`http://127.0.0.1:${String(port)}`] : [],
      })
    }
  )
})

describe('bindHost', () => {
  it('exits 4 naming another Log Book when the taken port answers with its header', async () => {
    // Arrange
    const port = await serverOnPort(true)

    // Act
    const binding = bindHost(() => undefined, port)

    // Assert
    const error = await binding.catch((caught: unknown) => caught)
    expect(errorReport(error, { version: '0.0.0-development', home: '/home/example', command: 'start' })).toStrictEqual(
      {
        code: 4,
        line: `Port ${String(port)} on 127.0.0.1 is used by another Log Book, on a different warehouse. Start this one on another port: logbook --port ${String(port + 1)}`,
      }
    )
  })

  it('exits 4 naming another program when the taken port answers without the header', async () => {
    // Arrange
    const port = await serverOnPort(false)

    // Act
    const binding = bindHost(() => undefined, port)

    // Assert
    const error = await binding.catch((caught: unknown) => caught)
    expect(errorReport(error, { version: '0.0.0-development', home: '/home/example', command: 'start' })).toStrictEqual(
      {
        code: 4,
        line: `Port ${String(port)} on 127.0.0.1 is in use by another program. Start Log Book on another port: logbook --port ${String(port + 1)}`,
      }
    )
  })
})

// Runs the host with stand-ins for the web app, detection and the registry, until it serves; then stops it.
const serveOnce = async (
  values: Readonly<Record<string, number | boolean>>
): Promise<{ spawns: number; pages: string[]; stdout: string }> => {
  const warehouse = await warehouseIn()
  vi.stubEnv('LOGBOOK_DB', warehouse)
  vi.stubEnv('XDG_DATA_HOME', directory)
  vi.stubEnv('LOGBOOK_CLI', '')
  vi.stubEnv('LOGBOOK_HOST_VERSION', '')
  let spawns = 0
  const pages: string[] = []
  const registry: IChildRegistry = {
    spawn: () => {
      spawns += 1
      return Object.assign(new EventEmitter(), { stderr: new EventEmitter() }) as unknown as ChildProcess
    },
    logOf: () => join(directory, 'sync.log'),
    terminate: async () => Promise.resolve(),
    stop: async () => Promise.resolve(),
    kill: () => undefined,
  }
  const stop = new EventEmitter()
  const sources: IHostSources = {
    openWarehouse: WarehouseStore.open,
    environment: () => ({ variables: {}, homeDir: directory, cwd: directory, platform: 'linux' }),
    loadWebApp: async () =>
      Promise.resolve({
        guard: { checkRequest: () => ({ isAccepted: true }), responseHeaders: () => ({}) },
        handler: (_req, res) => {
          res.end()
        },
        clientDirectory: directory,
      }),
    detect: async () => new Promise(() => undefined),
    createRegistry: () => registry,
    openBrowser: (url, report) => {
      pages.push(url)
      report('Browser      not opened: no xdg-open on this machine.')
    },
    signals: (listener) => {
      stop.on('signal', listener)
      return () => stop.off('signal', listener)
    },
  }
  let stdout = ''
  const running = createHostRunner(sources)({
    command: 'start',
    values: { port: 0, interval: 5, ...values },
    positionals: [],
    version: '0.0.0-development',
    io: {
      argv: [],
      env: {},
      home: directory,
      stdout: (text) => {
        stdout += text
      },
      stderr: () => undefined,
      isStderrTty: false,
      signal: new AbortController().signal,
    },
  })
  await vi.waitFor(() => {
    expect(stdout).toContain('Press Ctrl+C to stop.')
  })
  stop.emit('signal')
  await running
  return { spawns, pages, stdout }
}

describe('the host runner and its syncs', () => {
  it('starts no sync with --no-sync', async () => {
    // Act
    const { spawns } = await serveOnce({ 'no-sync': true })

    // Assert
    expect(spawns).toBe(0)
  })

  it('starts the first sync once it serves', async () => {
    // Act
    const { spawns } = await serveOnce({})

    // Assert
    expect(spawns).toBe(1)
  })
})

describe('the host runner and the browser', () => {
  it('opens the printed page once it serves, and prints what the opener reports', async () => {
    // Act
    const { pages, stdout } = await serveOnce({ 'no-sync': true })
    const url = /Log Book is running at (?<url>\S+)/u.exec(stdout)?.groups?.url

    // Assert
    expect({
      pages,
      isReported: stdout.includes('Browser      not opened: no xdg-open on this machine.\n'),
    }).toStrictEqual({
      pages: [url],
      isReported: true,
    })
  })

  it('opens nothing with --no-open', async () => {
    // Act
    const { pages } = await serveOnce({ 'no-sync': true, 'no-open': true })

    // Assert
    expect(pages).toStrictEqual([])
  })
})
