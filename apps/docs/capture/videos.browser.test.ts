import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { guarded, textOf } from './capture.js'
import { siteVideoOf } from './captures.js'
import type { DemoPlan } from './shots.js'
import { addPointer, recordVideo, VIDEOS, type IVideo, type IVideoRecord, type VideoId } from './videos.js'

interface IStub {
  url: string
  // The paths the browser asked for, query included.
  requested: string[]
}

const SETTLE_MS = 1000
const SESSION = 'stub:session-1'
const CONVERSATION = `/conversations/${encodeURIComponent(SESSION)}`
// A policy with no 'unsafe-inline' for scripts or styles, as the web app sends.
const POLICY = "default-src 'self'"
// A plan holding what the videos read: the showcase conversation and its session's project.
const PLAN = {
  showcase: { key: 'shop/showcase', id: SESSION },
  plan: { sessions: [{ key: 'shop/showcase', project: 'shop' }] },
} as unknown as DemoPlan
const TOP_BAR = '<header class="top-bar"><a href="/">Dashboard</a><a href="/conversations">Conversations</a></header>'

const page = (body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body>${TOP_BAR}${body}</body></html>`

const card = (title: string): string =>
  `<section class="card"><h3 class="card__title">${title}</h3><p>${title} by week</p></section>`

// The dashboard's cards the tour points at, each tall enough that the page scrolls to the next.
const DASHBOARD = page(
  ['Time per turn', 'Reactions to the agent', 'Reactions from the agent']
    .map((title) => `<div class="stub-row">${card(title)}</div>`)
    .join('')
)

// Twenty turns of a thread in the session map's time mode, with a Turn pane for every turn.
const NUMBERS = Array.from({ length: 20 }, (_turn, index) => String(index + 1))
const CONVERSATION_PAGE = page(
  `<div data-map data-mode="time">Session map</div><div data-thread>${NUMBERS.map(
    (number) => `<div data-turn="t${number}"><p>Turn ${number.padStart(2, '0')}</p><br><br><br><br><br><br></div>`
  ).join('')}</div>${NUMBERS.map((number) => `<section data-turn-pane="t${number}">Pane ${number}</section>`).join('')}`
)

const FIXTURES: Readonly<Record<string, string>> = {
  '/': DASHBOARD,
  '/conversations': page(`<h1>Conversations</h1><a href="${CONVERSATION}">Build the cart</a>`),
  [CONVERSATION]: CONVERSATION_PAGE,
}

const servers: Server[] = []
const browsers: Browser[] = []
const directories: string[] = []

// A host serving the fixtures by path under the policy, the query left out, and recording every request.
const stubHost = async (): Promise<IStub> => {
  const requested: string[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    requested.push(`${url.pathname}${url.search}`)
    const body = FIXTURES[url.pathname]
    response.writeHead(body === undefined ? 404 : 200, {
      'content-type': 'text/html',
      'content-security-policy': POLICY,
    })
    response.end(body ?? '')
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, requested }
}

const launch = async (): Promise<Browser> => {
  const browser = await chromium.launch({ headless: true })
  browsers.push(browser)
  return browser
}

const videoNamed = (id: VideoId): IVideo => {
  const video = VIDEOS.find((candidate) => candidate.id === id)
  if (video === undefined) {
    throw new Error(`No video ${id}`)
  }
  return video
}

// One video against the stub host at the page's own pace, into a temporary directory.
const record = async (host: string, id: VideoId): Promise<{ record: IVideoRecord; directory: string }> => {
  const browser = await launch()
  const directory = await mkdtemp(join(tmpdir(), 'docs-video-test-'))
  directories.push(directory)
  const recorded = await recordVideo({
    browser,
    host,
    plan: PLAN,
    video: videoNamed(id),
    directory,
    settleMs: SETTLE_MS,
    beatMs: 0,
  })
  return { record: recorded, directory }
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

describe('the drawn pointer', () => {
  it("follows the mouse under a policy without 'unsafe-inline', breaks no policy and adds no text", async () => {
    // Arrange
    const host = await stubHost()
    const browser = await launch()
    const [plain, pointed] = await Promise.all([browser.newContext(), browser.newContext()])
    await addPointer(pointed)
    const [plainPage, pointedPage] = await Promise.all([plain.newPage(), pointed.newPage()])
    const problems = await guarded(pointedPage, host.url)

    // Act
    await Promise.all([plainPage.goto(host.url), pointedPage.goto(host.url)])
    await pointedPage.mouse.move(120, 80)
    const pointer = await pointedPage.evaluate(() => {
      const element = document.documentElement.lastElementChild
      return element instanceof HTMLElement
        ? { tag: element.tagName, transform: element.style.transform, text: element.textContent }
        : null
    })

    // Assert
    expect({
      pointer,
      problems,
      isTextSame: (await textOf(pointedPage)) === (await textOf(plainPage)),
    }).toStrictEqual({
      pointer: { tag: 'DIV', transform: 'translate(120px, 80px)', text: '' },
      problems: [],
      isTextSame: true,
    })
  })
})

describe('recordVideo', () => {
  it('records the scroll animation as an MP4 whose text capture is the page without the pointer', async () => {
    // Arrange
    const host = await stubHost()
    const plain = await (await (await launch()).newContext()).newPage()

    // Act
    const { record: recorded, directory } = await record(host.url, 'conversation-scroll')
    await plain.goto(new URL(CONVERSATION, host.url).href)

    // Assert
    expect({
      record: recorded,
      hasVideo: (await stat(join(directory, recorded.file))).size > 0,
      isTextPlain: (await readFile(join(directory, 'conversation-scroll-1.txt'), 'utf8')) === (await textOf(plain)),
    }).toStrictEqual({
      record: {
        file: 'conversation-scroll.mp4',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) as string,
        video: 'conversation-scroll',
        scheme: 'dark',
        build: 'rich',
        viewport: [1280, 800],
        poster: 'conversation-dark.png',
        texts: [
          {
            file: 'conversation-scroll-1.txt',
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) as string,
            page: CONVERSATION,
          },
        ],
      },
      hasVideo: true,
      isTextPlain: true,
    })
  })

  it("opens the page of the plan's showcase from the conversations of its project in the tour", async () => {
    // Arrange
    const host = await stubHost()

    // Act
    const { record: recorded } = await record(host.url, 'tour')

    // Assert
    expect({ pages: recorded.texts.map((text) => text.page), requested: host.requested }).toStrictEqual({
      pages: ['/?range=7d', '/conversations?q=project%3Ashop', CONVERSATION, '/'],
      requested: ['/?range=7d', '/conversations?q=project%3Ashop', CONVERSATION, '/'],
    })
  })
})

describe('siteVideoOf', () => {
  it('throws on a video id the manifest does not have, naming it and the page', () => {
    // Arrange
    const captures = { shots: {}, videos: {}, files: [] }

    // Act
    const lookup = (): unknown => siteVideoOf(captures, 'nope', 'index.md')

    // Assert
    expect(lookup).toThrow('index.md shows the video nope, which the captures do not have; run pnpm docs:capture')
  })
})
