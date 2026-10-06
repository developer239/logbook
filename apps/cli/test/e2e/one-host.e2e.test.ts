import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, Server as HttpServer } from 'node:http'
import { createServer as createNetServer, type AddressInfo, type Server } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lineDifferences, useE2eHarness, type IE2eHome, type IStandInOpener, type IStartedHost } from './harness.js'

// One host per warehouse, a taken port and the browser opener, through the binary, in homes with no harness data.
const harness = useE2eHarness()

const OPENER = process.platform === 'darwin' ? 'open' : 'xdg-open'
const POLL_MS = 50
const WAIT_MS = 15_000
const HOST_ARGS = ['--no-sync', '--no-open']

const servers: Server[] = []
const children: ReturnType<typeof spawn>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve()
          })
          if (server instanceof HttpServer) {
            server.closeAllConnections()
          }
        })
    )
  )
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await once(child, 'exit')
      }
    })
  )
})

const emptyHome = async (): Promise<IE2eHome> => harness.createHome({ home: 'none' })
const hostFileOf = (home: IE2eHome): string => `${home.environment.LOGBOOK_DB ?? ''}.host`
const portOf = (host: IStartedHost): number => Number(new URL(host.url).port)

const readHostFile = async (home: IE2eHome): Promise<{ pid: number; port: number }> => {
  const { pid, port } = JSON.parse(await readFile(hostFileOf(home), 'utf8')) as { pid: number; port: number }
  return { pid, port }
}

const writeHostFile = async (home: IE2eHome, pid: number, port: number): Promise<void> => {
  await writeFile(
    hostFileOf(home),
    JSON.stringify({ pid, port, version: '0.0.0-development', startedAt: Date.now() }),
    { mode: 0o600 }
  )
}

const listen = async <TServer extends Server>(server: TServer): Promise<number> => {
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return (server.address() as AddressInfo).port
}

// The stand-in opener's calls once there are as many as expected.
const callsOf = async (opener: IStandInOpener, count: number): Promise<{ args: string[]; pid: number }[]> =>
  vi.waitFor(
    async () => {
      const calls = await opener.calls()
      if (calls.length < count) {
        throw new Error(`the opener was called ${String(calls.length)} times, not ${String(count)}`)
      }
      return calls.map(({ args, pid }) => ({ args, pid }))
    },
    { timeout: WAIT_MS, interval: POLL_MS }
  )

// The first stdout line that starts so, once printed.
const lineStarting = async (host: IStartedHost, start: string): Promise<string> =>
  vi.waitFor(
    () => {
      const line = host.output().stdout.find((candidate) => candidate.startsWith(start))
      if (line === undefined) {
        throw new Error(`no line starting ${JSON.stringify(start)} yet`)
      }
      return line
    },
    { timeout: WAIT_MS, interval: POLL_MS }
  )

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('one host per warehouse and its port', () => {
  it('finds the running host on a second start instead of starting another', async () => {
    // Arrange
    const home = await emptyHome()
    const first = await harness.startHost(home, { args: HOST_ARGS })

    // Act
    const second = await harness.run(home, ['--no-open'])

    // Assert
    expect({
      code: second.code,
      stdout: lineDifferences(second.stdout.slice(-1), [`Log Book is already running at ${first.url}`]),
      hostFile: (await readHostFile(home)).pid,
    }).toStrictEqual({ code: 0, stdout: [], hostFile: first.pid })
  })

  it('starts over a host file whose pid no process has', async () => {
    // Arrange
    const home = await emptyHome()
    const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await once(gone, 'exit')
    await writeHostFile(home, gone.pid ?? 0, 9)

    // Act
    const host = await harness.startHost(home, { args: HOST_ARGS })

    // Assert
    expect(await readHostFile(home)).toStrictEqual({ pid: host.pid, port: portOf(host) })
  })

  it("starts over a host file whose live pid answers without Log Book's header", async () => {
    // Arrange
    const home = await emptyHome()
    const alive = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1e9)'], { stdio: 'ignore' })
    children.push(alive)
    const port = await listen(
      createHttpServer((_request, response) => {
        response.end('not Log Book')
      })
    )
    await writeHostFile(home, alive.pid ?? 0, port)

    // Act
    const host = await harness.startHost(home, { args: HOST_ARGS })

    // Assert
    expect(await readHostFile(home)).toStrictEqual({ pid: host.pid, port: portOf(host) })
  })

  it('exits 4 on a port another Log Book holds, naming it and the next port', async () => {
    // Arrange
    const first = await harness.startHost(await emptyHome(), { args: HOST_ARGS })
    const port = portOf(first)
    const second = await emptyHome()

    // Act
    const start = await harness.run(second, ['start', '--port', String(port), ...HOST_ARGS])

    // Assert
    expect({ code: start.code, last: start.stderr.at(-1), hostFile: existsSync(hostFileOf(second)) }).toStrictEqual({
      code: 4,
      last:
        `Port ${String(port)} on 127.0.0.1 is used by another Log Book, on a different warehouse. Start this one on ` +
        `another port: logbook --port ${String(port + 1)}`,
      hostFile: false,
    })
  })

  it('exits 4 on a port another program holds, naming it and the next port', async () => {
    // Arrange
    const home = await emptyHome()
    // A program that takes the port and drops every connection, as one that speaks no HTTP would.
    const port = await listen(
      createNetServer((socket) => {
        socket.destroy()
      })
    )

    // Act
    const start = await harness.run(home, ['start', '--port', String(port), ...HOST_ARGS])

    // Assert
    expect({ code: start.code, last: start.stderr.at(-1), hostFile: existsSync(hostFileOf(home)) }).toStrictEqual({
      code: 4,
      last:
        `Port ${String(port)} on 127.0.0.1 is in use by another program. Start Log Book on another port: ` +
        `logbook --port ${String(port + 1)}`,
      hostFile: false,
    })
  })
})

describe('opening the browser', () => {
  it('calls the opener once with exactly the printed URL', async () => {
    // Arrange
    const home = await emptyHome()
    const opener = await harness.installOpener(home, { exitCode: 0 })

    // Act
    const host = await harness.startHost(home, { args: ['--no-sync'], opener })
    const printed = await lineStarting(host, 'Log Book is running at ')
    await callsOf(opener, 1)
    await host.stop()

    // Assert
    expect({ printed, calls: (await opener.calls()).map(({ args }) => args) }).toStrictEqual({
      printed: `Log Book is running at ${host.url}`,
      calls: [[host.url]],
    })
  })

  it('never calls the opener with --no-open', async () => {
    // Arrange
    const home = await emptyHome()
    const opener = await harness.installOpener(home, { exitCode: 0 })

    // Act
    const host = await harness.startHost(home, { args: HOST_ARGS, opener })
    // The opener would be called before labelling is looked for, whose line comes last.
    await lineStarting(host, 'Labelling    ')
    await host.stop()

    // Assert
    expect(await opener.calls()).toStrictEqual([])
  })

  it("opens the running host's URL on a second start without --no-open", async () => {
    // Arrange
    const home = await emptyHome()
    const opener = await harness.installOpener(home, { exitCode: 0 })
    const first = await harness.startHost(home, { args: HOST_ARGS, opener })

    // Act
    const second = await harness.run(home, ['start', '--port', '0', '--no-sync'], { firstOnPath: opener.directory })

    // Assert
    expect({ code: second.code, calls: (await callsOf(opener, 1)).map(({ args }) => args) }).toStrictEqual({
      code: 0,
      calls: [[first.url]],
    })
  })

  it.for([
    {
      name: 'an opener that exits 3',
      reason: `${OPENER} exited with code 3`,
      setUp: async (home: IE2eHome): Promise<{ opener?: IStandInOpener; onlyOnPath?: string }> => ({
        opener: await harness.installOpener(home, { exitCode: 3 }),
      }),
    },
    {
      name: 'a PATH that reaches no opener',
      reason: `no ${OPENER} on this machine`,
      setUp: async (home: IE2eHome): Promise<{ opener?: IStandInOpener; onlyOnPath?: string }> => {
        const onlyOnPath = join(home.out, 'empty-path')
        await mkdir(onlyOnPath)
        return { onlyOnPath }
      },
    },
  ])('reports $name and keeps serving', async ({ reason, setUp }) => {
    // Arrange
    const home = await emptyHome()
    const opening = await setUp(home)

    // Act
    const host = await harness.startHost(home, { args: ['--no-sync'], ...opening })
    const line = await lineStarting(host, 'Browser      ')
    const root = await fetch(host.url)
    const code = await host.stop()

    // Assert
    expect({ line, root: root.status, code }).toStrictEqual({
      line: `Browser      not opened: ${reason}. Open ${host.url} yourself, or start with logbook --no-open.`,
      root: 200,
      code: 0,
    })
  })

  it('leaves an opener that stays alive running after the host exits, as it was started detached', async () => {
    // Arrange
    const home = await emptyHome()
    const opener = await harness.installOpener(home, 'stay-alive')
    const host = await harness.startHost(home, { args: ['--no-sync'], opener })
    const [call] = await callsOf(opener, 1)

    // Act
    const code = await host.stop()

    // Assert
    expect({ code, isOpenerAlive: isProcessAlive(call?.pid ?? 0) }).toStrictEqual({ code: 0, isOpenerAlive: true })
  })
})
