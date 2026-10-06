import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { captureShot, type ICaptureRecord } from './capture.js'
import { runCapture } from './main.js'
import { SHOTS, type DemoPlan, type IShot } from './shots.js'

interface IFixture {
  body: string
  headers?: Readonly<Record<string, string>>
}

interface IStub {
  url: string
  // The paths the browser asked for, query included.
  requested: string[]
}

const SETTLE_MS = 1000
const SESSION = 'stub:session-1'
const CONVERSATION = `/conversations/${encodeURIComponent(SESSION)}`
const DASHBOARD = '<h3>Tool problems</h3><h3>Reactions to the agent</h3><h3>Reactions from the agent</h3>'
const NOT_LABELLED = '<p class="labels-missing">These need labels from a model.</p>'
// A plan holding what the shots read: the showcase conversation and the sessions' goals and outcomes.
const PLAN = { showcase: { key: 'shop/showcase', id: SESSION }, plan: { sessions: [] } } as unknown as DemoPlan

const page = (body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`

// Twelve turns of a thread, the Turn pane showing the last of them, and the texts the conversation shots expect.
const conversationPage = (): string => {
  const turns = Array.from(
    { length: 12 },
    (_turn, index) =>
      `<div data-turn="t${String(index + 1)}" style="height:400px">Turn ${String(index + 1).padStart(2, '0')}</div>`
  ).join('')
  return page(
    `<div data-map style="height:48px"></div><div data-thread>${turns}</div>` +
      '<section data-turn-pane="t12">Turn 12 · pnpm test · failed with a real result</section>'
  )
}

const servers: Server[] = []
const browsers: Browser[] = []
const directories: string[] = []

// A host serving the fixtures by path, the query left out, and recording every request.
const stubHost = async (fixtures: Readonly<Record<string, IFixture>>): Promise<IStub> => {
  const requested: string[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    requested.push(`${url.pathname}${url.search}`)
    const fixture = fixtures[url.pathname]
    response.writeHead(fixture === undefined ? 404 : 200, { 'content-type': 'text/html', ...fixture?.headers })
    response.end(fixture?.body ?? '')
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, requested }
}

const shotNamed = (id: string): IShot => {
  const shot = SHOTS.find((candidate) => candidate.id === id)
  if (shot === undefined) {
    throw new Error(`No shot ${id}`)
  }
  return shot
}

// One shot in the dark scheme against the stub host, into a temporary directory.
const capture = async (host: string, id: string): Promise<{ record: ICaptureRecord; directory: string }> => {
  const browser = await chromium.launch({ headless: true })
  browsers.push(browser)
  const directory = await mkdtemp(join(tmpdir(), 'docs-capture-'))
  directories.push(directory)
  const context = await browser.newContext({ colorScheme: 'dark' })
  const record = await captureShot({
    context,
    host,
    plan: PLAN,
    shot: shotNamed(id),
    scheme: 'dark',
    directory,
    settleMs: SETTLE_MS,
  })
  return { record, directory }
}

const failureOf = async (host: string, id: string): Promise<string> => {
  try {
    await capture(host, id)
    return 'captured'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
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
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('captureShot', () => {
  it('opens the showcase conversation the plan names for the conversation and turn-pane shots', async () => {
    // Arrange
    const host = await stubHost({ [CONVERSATION]: { body: conversationPage() } })

    // Act
    const pages = [
      (await capture(host.url, 'conversation')).record.page,
      (await capture(host.url, 'turn-pane')).record.page,
    ]

    // Assert
    expect({ pages, requested: host.requested.filter((path) => path.startsWith('/conversations')) }).toStrictEqual({
      pages: [CONVERSATION, CONVERSATION],
      requested: [CONVERSATION, CONVERSATION],
    })
  })

  it('fails a shot whose page lacks an expected text, naming the shot and the text', async () => {
    // Arrange
    const host = await stubHost({ '/tokens': { body: page('<h1>Tokens</h1>') } })

    // Act
    const failure = await failureOf(host.url, 'tokens')

    // Assert
    expect(failure).toBe('tokens (dark): the page does not show "Tokens by tool"')
  })

  it('fails a page that asks another origin for something', async () => {
    // Arrange
    const host = await stubHost({
      '/tokens': { body: page('<h1>Tokens by tool</h1><img src="http://127.0.0.1:9/x.png">') },
    })

    // Act
    const failure = await failureOf(host.url, 'tokens')

    // Assert
    expect(failure).toBe('tokens (dark): a request to another origin: http://127.0.0.1:9/x.png')
  })

  it('fails a page that logs a Content Security Policy violation', async () => {
    // Arrange
    const host = await stubHost({
      '/tokens': {
        body: page('<h1>Tokens by tool</h1><script>document.title = "inline"</script>'),
        headers: { 'content-security-policy': "script-src 'none'" },
      },
    })

    // Act
    const failure = await failureOf(host.url, 'tokens')

    // Assert
    expect(failure).toMatch(/^tokens \(dark\): a Content Security Policy violation: /u)
  })

  it('fails every shot on the "not labelled yet" panel except the not-labelled shot, which captures it', async () => {
    // Arrange
    const host = await stubHost({ '/': { body: page(`${DASHBOARD}${NOT_LABELLED}`) } })

    // Act
    const [dashboard, notLabelled] = [await failureOf(host.url, 'dashboard'), await failureOf(host.url, 'not-labelled')]

    // Assert
    expect({ dashboard, notLabelled }).toStrictEqual({
      dashboard: 'dashboard (dark): the page shows the "not labelled yet" panel (These need labels from a model. ...)',
      notLabelled: 'captured',
    })
  })

  it("writes the page's visible text, then its link and source targets, one per line", async () => {
    // Arrange
    const host = await stubHost({
      '/tokens': { body: page('<h1>Tokens by tool</h1><a href="/steps">Steps</a><img src="/chart.svg" alt="">') },
    })

    // Act
    const { record, directory } = await capture(host.url, 'tokens')

    // Assert
    expect((await readFile(join(directory, record.text), 'utf8')).split('\n')).toStrictEqual([
      'Tokens by tool',
      'Steps',
      '/steps',
      '/chart.svg',
    ])
  })
})

describe('runCapture', () => {
  it('stops with DEMO_TZ_NOT_UTC before any build when the zone is not UTC', async () => {
    // Arrange
    const lines: string[] = []

    // Act
    const code = await runCapture([], (line) => {
      lines.push(line)
    })

    // Assert
    expect({ isUtc: process.env.TZ === 'UTC', code, line: lines.join('').split(':')[1]?.trim() }).toStrictEqual({
      isUtc: false,
      code: 1,
      line: 'DEMO_TZ_NOT_UTC',
    })
  })
})
