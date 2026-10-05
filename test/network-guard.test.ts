import dns from 'node:dns'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const errorOf = async (attempt: () => Promise<unknown>): Promise<string> => {
  try {
    await attempt()
  } catch (error: unknown) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : ''
    return [error instanceof Error ? error.message : String(error), cause].filter((text) => text !== '').join(' / ')
  }
  return 'no error'
}

const connectError = async (options: net.NetConnectOpts): Promise<string> =>
  new Promise((resolve) => {
    const socket = net.connect(options)
    socket.on('error', (error) => {
      resolve(error.message)
    })
    socket.on('connect', () => {
      socket.destroy()
      resolve('connected')
    })
  })

const listening = async (server: net.Server | Server, ...args: unknown[]): Promise<void> =>
  new Promise((resolve) => {
    server.listen(...(args as [number, string]), () => {
      resolve()
    })
  })

const closed = async (server: net.Server | Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => {
      resolve()
    })
  })

describe('the network guard', () => {
  it('refuses a TCP connection outside loopback, naming the address and port', async () => {
    // Act
    const message = await connectError({ host: '192.0.2.1', port: 80 })

    // Assert
    expect(message).toBe('Network access is blocked in tests: 192.0.2.1:80')
  })

  it.each([
    ['fetch of an address', async () => fetch('http://192.0.2.1/'), '192.0.2.1:80'],
    ['fetch of a host name', async () => fetch('https://example.com/'), 'example.com'],
    ['a promise lookup', async () => dns.promises.lookup('example.com'), 'example.com'],
    [
      'a callback lookup',
      async () =>
        new Promise((resolve, reject) => {
          dns.lookup('example.com', (error, address) => (error === null ? resolve(address) : reject(error)))
        }),
      'example.com',
    ],
  ])('refuses %s, naming what it refused', async (_case, attempt, target) => {
    // Act
    const message = await errorOf(attempt)

    // Assert
    expect(message).toContain(`Network access is blocked in tests: ${target}`)
  })

  it('allows a connection and a fetch to a server on 127.0.0.1, and a connection by the name localhost', async () => {
    // Arrange
    const server = createServer((_request, response) => response.end('ok'))
    await listening(server, 0, '127.0.0.1')
    const named = net.createServer((socket) => socket.end())
    await listening(named, 0, 'localhost')
    const { port } = server.address() as net.AddressInfo

    // Act
    const results = {
      connect: await connectError({ host: '127.0.0.1', port }),
      fetch: await (await fetch(`http://127.0.0.1:${String(port)}/`)).text(),
      localhost: await connectError({ host: 'localhost', port: (named.address() as net.AddressInfo).port }),
    }

    // Assert
    await closed(server)
    await closed(named)
    expect(results).toStrictEqual({ connect: 'connected', fetch: 'ok', localhost: 'connected' })
  })

  it('allows a Unix domain socket', async () => {
    // Arrange
    const directory = await mkdtemp(join(tmpdir(), 'log-book-socket-'))
    const path = join(directory, 'test.sock')
    const server = net.createServer((socket) => socket.end())
    await listening(server, path)

    // Act
    const result = await connectError({ path })

    // Assert
    await closed(server)
    await rm(directory, { recursive: true, force: true })
    expect(result).toBe('connected')
  })
})
