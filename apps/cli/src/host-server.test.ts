import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeServer, createRequestListener, HOST_SERVER_URL, listen, portOf, type IWebApp } from './host-server.js'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ALLOWLIST = join(REPOSITORY_ROOT, 'packages/engine/network-call-sites.json')
const VERSION = '1.2.3'

interface IReply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

interface IHandled {
  url: string
  locals: unknown
}

let directory = ''
let server: Server | null = null
let handled: IHandled[] = []

// A stand-in guard: refuses the Host evil.example, and names the version it was given.
const guard: IWebApp['guard'] = {
  checkRequest: ({ host }) =>
    host?.startsWith('evil.example') === true
      ? { isAccepted: false, status: 403, body: 'refused' }
      : { isAccepted: true },
  responseHeaders: (version) => ({ 'X-Policy': 'on', ...(version === undefined ? {} : { 'x-log-book': version }) }),
}

const handler: IWebApp['handler'] = (req, res, _next, locals) => {
  handled.push({ url: req.url ?? '', locals })
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end('page')
}

const serve = async (locals: object): Promise<number> => {
  const app: IWebApp = { guard, handler, clientDirectory: directory }
  server = await listen(
    createRequestListener(app, VERSION, locals, () => undefined),
    0
  )
  return portOf(server)
}

const send = async (port: number, path: string, headers: Record<string, string> = {}): Promise<IReply> =>
  new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path, headers }, (incoming) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () => {
        resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks).toString() })
      })
    })
    outgoing.on('error', reject)
    outgoing.end()
  })

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'host-server-'))
  await mkdir(join(directory, '_astro'))
  await writeFile(join(directory, '_astro', 'page.css'), 'body{}')
  handled = []
})

afterEach(async () => {
  if (server !== null) {
    await closeServer(server)
    server = null
  }
  await rm(directory, { recursive: true, force: true })
})

describe('createRequestListener', () => {
  it('answers a refused request with the refusal alone, never reaching the app', async () => {
    // Arrange
    const port = await serve({ children: 'registry' })

    // Act
    const reply = await send(port, '/', { Host: 'evil.example' })

    // Assert
    expect({
      status: reply.status,
      body: reply.body,
      version: reply.headers['x-log-book'],
      policy: reply.headers['x-policy'],
      handled,
    }).toStrictEqual({ status: 403, body: 'refused', version: undefined, policy: undefined, handled: [] })
  })

  it("serves a client file of the build itself, with the guard's headers and the host's version", async () => {
    // Arrange
    const port = await serve({ children: 'registry' })

    // Act
    const reply = await send(port, '/_astro/page.css')

    // Assert
    expect({
      status: reply.status,
      type: reply.headers['content-type'],
      body: reply.body,
      version: reply.headers['x-log-book'],
      policy: reply.headers['x-policy'],
      handled,
    }).toStrictEqual({
      status: 200,
      type: 'text/css; charset=utf-8',
      body: 'body{}',
      version: VERSION,
      policy: 'on',
      handled: [],
    })
  })

  it('passes an app route to the handler with the registry in locals, and adds the headers', async () => {
    // Arrange
    const locals = { children: 'registry' }
    const port = await serve(locals)

    // Act
    const reply = await send(port, '/conversations?page=2')

    // Assert
    expect({ status: reply.status, body: reply.body, version: reply.headers['x-log-book'], handled }).toStrictEqual({
      status: 200,
      body: 'page',
      version: VERSION,
      handled: [{ url: '/conversations?page=2', locals }],
    })
  })

  it('leaves a path outside the client directory, or a client file that is not there, to the handler', async () => {
    // Arrange
    const port = await serve({ children: 'registry' })

    // Act
    const replies = [await send(port, '/_astro/../../secret'), await send(port, '/_astro/missing.js')]

    // Assert
    expect(replies.map((reply) => reply.body)).toStrictEqual(['page', 'page'])
  })
})

describe('listen', () => {
  it('binds 127.0.0.1 at the port the system chose', async () => {
    // Act
    await serve({})

    // Assert
    expect(server?.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' })
  })

  it('is listed in the network allowlist as a local call site, by its own path', async () => {
    // Arrange
    const sites = JSON.parse(await readFile(ALLOWLIST, 'utf8')) as { file: string; case: string }[]
    const file = relative(REPOSITORY_ROOT, fileURLToPath(HOST_SERVER_URL))

    // Act
    const entries = sites.filter((site) => site.file === file).map((site) => site.case)

    // Assert
    expect(entries).toStrictEqual(['local'])
  })
})
