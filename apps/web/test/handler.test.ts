import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createTestWarehouse, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { HOST_REFUSAL, ORIGIN_REFUSAL } from '../src/lib/guard'

type THandler = (req: IncomingMessage, res: ServerResponse, next?: (error?: unknown) => void) => void | Promise<void>

const DIST = fileURLToPath(new URL('../dist', import.meta.url))
const STYLESHEET = /<link[^>]+rel="stylesheet"[^>]+href="(?<href>[^"]+)"/gu
const FONT = /url\((?<url>[^)]+\.woff2)\)/gu

let directory = ''
let warehouse: ITestWarehouse | undefined
let origin = ''
let close: () => Promise<void> = async () => Promise.resolve()

// The build copied away from the repository, as the CLI's tarball holds it, mounted on a server this test binds.
beforeAll(async () => {
  if (!existsSync(join(DIST, 'server', 'entry.mjs'))) {
    throw new Error('The web app is not built; run pnpm build:packages first')
  }
  directory = await mkdtemp(join(tmpdir(), 'web-handler-'))
  await cp(DIST, join(directory, 'dist'), { recursive: true })
  warehouse = await createTestWarehouse()
  vi.stubEnv('LOGBOOK_DB', warehouse.path)
  const { handler } = (await import(pathToFileURL(join(directory, 'dist', 'server', 'entry.mjs')).href)) as {
    handler: THandler
  }
  const server = createServer((req, res) => {
    void handler(req, res, () => {
      res.statusCode = 404
      res.end()
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  close = async () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
})

afterAll(async () => {
  await close()
  await warehouse?.remove()
  await rm(directory, { recursive: true, force: true })
})

const clientFile = (url: string): string => join(directory, 'dist', 'client', url.replace(/^\//u, ''))

interface IReply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

// fetch will not send a Host header of its own choosing; node:http will.
const send = async (method: string, path: string, headers: Record<string, string>, body = ''): Promise<IReply> =>
  new Promise((resolve, reject) => {
    const outgoing = request(`${origin}${path}`, { method, headers }, (incoming) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () => {
        resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks).toString() })
      })
    })
    outgoing.on('error', reject)
    outgoing.end(body)
  })

const POLICY_HEADERS = ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-log-book']

describe('the built handler, away from the repository', () => {
  it('answers GET / with 200, and every stylesheet and font the page names is a file of its client build', async () => {
    // Act
    const response = await fetch(`${origin}/`)
    const page = await response.text()

    // Assert
    const stylesheets = [...page.matchAll(STYLESHEET)].map((match) => match.groups?.href ?? '')
    const css = await Promise.all(stylesheets.map(async (href) => readFile(clientFile(href), 'utf8')))
    const fonts = [...new Set(css.flatMap((text) => [...text.matchAll(FONT)].map((match) => match.groups?.url ?? '')))]
    expect({
      status: response.status,
      hasStylesheets: stylesheets.length > 0,
      fonts: fonts.toSorted(),
      missing: [...stylesheets, ...fonts].filter((url) => !existsSync(clientFile(url))),
    }).toStrictEqual({
      status: 200,
      hasStylesheets: true,
      fonts: ['/fonts/Geist-Variable.woff2', '/fonts/GeistMono-Variable.woff2'],
      missing: [],
    })
  })
})

describe('the guard in the built handler', () => {
  it('refuses a request addressed to another name with 403, the reason and none of the page headers', async () => {
    // Act
    const reply = await send('GET', '/', { Host: 'evil.example:4321' })

    // Assert
    expect({
      status: reply.status,
      body: reply.body,
      policy: POLICY_HEADERS.filter((name) => name in reply.headers),
    }).toStrictEqual({ status: 403, body: HOST_REFUSAL, policy: [] })
  })

  it('sends the policy headers on an accepted page, and no version', async () => {
    // Act
    const reply = await send('GET', '/', {})

    // Assert
    expect({
      status: reply.status,
      policy: POLICY_HEADERS.filter((name) => name in reply.headers),
      nosniff: reply.headers['x-content-type-options'],
      referrer: reply.headers['referrer-policy'],
      frames: reply.headers['content-security-policy']?.includes("frame-ancestors 'none'"),
    }).toStrictEqual({
      status: 200,
      policy: ['content-security-policy', 'x-content-type-options', 'referrer-policy'],
      nosniff: 'nosniff',
      referrer: 'no-referrer',
      frames: true,
    })
  })

  it('refuses a cross-site POST that is not form-like, which the framework lets through', async () => {
    // Act
    const reply = await send(
      'POST',
      '/sync',
      { 'Content-Type': 'application/json', 'Origin': 'http://evil.example' },
      '{"back":"/"}'
    )

    // Assert
    expect({ status: reply.status, body: reply.body }).toStrictEqual({ status: 403, body: ORIGIN_REFUSAL })
  })
})
