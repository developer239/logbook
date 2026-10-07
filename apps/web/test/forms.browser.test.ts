import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, type Browser } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { checkRequest, responseHeaders } from '../src/lib/guard'

const servers: Server[] = []
const browsers: Browser[] = []

// A host that answers as Log Book's does: a page with a POST form, under the response headers every accepted response
// carries, and the form's target behind the request check, answering what it decided and the Origin it saw.
const formHost = async (): Promise<string> => {
  const server = createServer((request, response) => {
    const origin = request.headers.origin ?? null
    const verdict = checkRequest({ method: request.method ?? 'GET', host: request.headers.host ?? null, origin })
    if (!verdict.isAccepted) {
      response.writeHead(verdict.status, { 'content-type': 'text/plain' })
      response.end(`${verdict.body} Origin: ${String(origin)}`)
      return
    }
    response.writeHead(200, { ...responseHeaders(), 'content-type': 'text/html' })
    response.end(
      request.method === 'POST'
        ? `<p id="answer">accepted, Origin: ${String(origin)}</p>`
        : '<form method="post" action="/change"><button id="send" type="submit">Send</button></form>'
    )
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

afterEach(async () => {
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()))
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
})

describe("a form on one of Log Book's pages", () => {
  it('is accepted when Chromium submits it, under the headers the pages carry', async () => {
    // Arrange
    const host = await formHost()
    const browser = await chromium.launch({ headless: true })
    browsers.push(browser)
    const page = await browser.newPage()
    await page.goto(`${host}/`)

    // Act
    await Promise.all([page.waitForURL(`${host}/change`), page.click('#send')])

    // Assert
    expect(await page.textContent('body')).toBe(`accepted, Origin: ${host}`)
  })
})
