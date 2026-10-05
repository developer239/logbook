import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, resolve, sep } from 'node:path'
import type { handler } from '@log-book/web'
import type * as Guard from '@log-book/web/guard'

// This module's own location, which the network allowlist test reads, so moving the file without its entry fails.
export const HOST_SERVER_URL = import.meta.url

// The literal address the host binds; there is no flag or variable to move it.
export const HOST_ADDRESS = '127.0.0.1'

// What the host serves, from the web app's build: its request guard, its handler and its client files.
export interface IWebApp {
  guard: Pick<typeof Guard, 'checkRequest' | 'responseHeaders'>
  handler: typeof handler
  // The build's client directory, absolute.
  clientDirectory: string
}

// The web build's client files; the handler in middleware mode renders the app's routes only.
const CLIENT_PREFIXES = ['/_astro/', '/fonts/']

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
}

const PLAIN_TEXT = 'text/plain; charset=utf-8'

const NOT_FOUND = 404
const SERVER_ERROR = 500

const isRead = (method: string | undefined): boolean => method === 'GET' || method === 'HEAD'

// The client file a request names, or null: outside the client prefixes, outside the directory, or not a file.
const clientFileOf = async (directory: string, url: string): Promise<{ path: string; size: number } | null> => {
  const { pathname } = new URL(url, `http://${HOST_ADDRESS}`)
  if (!CLIENT_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return null
  }
  let decoded = ''
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // A malformed escape names no file; the handler answers it.
    return null
  }
  const path = resolve(directory, `.${decoded}`)
  if (!path.startsWith(`${directory}${sep}`)) {
    return null
  }
  const found = await stat(path).catch(() => null)
  return found?.isFile() === true ? { path, size: found.size } : null
}

const answer = async (
  app: IWebApp,
  version: string,
  locals: object,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> => {
  const verdict = app.guard.checkRequest({
    method: req.method ?? '',
    host: req.headers.host ?? null,
    origin: req.headers.origin ?? null,
  })
  if (!verdict.isAccepted) {
    res.writeHead(verdict.status, { 'Content-Type': PLAIN_TEXT })
    res.end(verdict.body)
    return
  }

  for (const [name, value] of Object.entries(app.guard.responseHeaders(version))) {
    res.setHeader(name, value)
  }

  const file = isRead(req.method) ? await clientFileOf(app.clientDirectory, req.url ?? '/') : null
  if (file !== null) {
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(file.path)] ?? 'application/octet-stream',
      'Content-Length': String(file.size),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(file.path).pipe(res)
    return
  }

  await app.handler(
    req,
    res,
    (error) => {
      res.writeHead(error === undefined ? NOT_FOUND : SERVER_ERROR, { 'Content-Type': PLAIN_TEXT })
      res.end()
    },
    locals
  )
}

// Every request, in order: the guard, the header set with the host's version, the client files, then the handler
// with `locals`. A refusal gets its status and body and nothing else. `report` hears what failed under the handler.
export const createRequestListener =
  (app: IWebApp, version: string, locals: object, report: (error: unknown) => void) =>
  (req: IncomingMessage, res: ServerResponse): void => {
    answer(app, version, locals, req, res).catch((error: unknown) => {
      report(error)
      if (!res.headersSent) {
        res.writeHead(SERVER_ERROR, { 'Content-Type': PLAIN_TEXT })
      }
      res.end()
    })
  }

// Binds 127.0.0.1 at the port; 0 lets the system choose.
export const listen = async (
  listener: (req: IncomingMessage, res: ServerResponse) => void,
  port: number
): Promise<Server> =>
  new Promise((resolveServer, reject) => {
    const server = createServer(listener)
    server.once('error', reject)
    server.listen(port, HOST_ADDRESS, () => {
      server.off('error', reject)
      resolveServer(server)
    })
  })

export const portOf = (server: Server): number => (server.address() as AddressInfo).port

// Stops accepting, and ends the connections a browser keeps open, so the port is free when this resolves.
export const closeServer = async (server: Server): Promise<void> =>
  new Promise((resolveClosed) => {
    server.close(() => {
      resolveClosed()
    })
    server.closeAllConnections()
  })
