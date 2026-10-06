import { existsSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, relative } from 'node:path'
import { chromium, type Browser } from 'playwright'
import type { IFinding } from '../scripts/k7.js'

export interface IK9Inputs {
  // The built site, such as .vitepress/dist.
  built: string
  // The path the site is served under, such as /logbook/.
  basePath: string
  // Findings name files relative to it.
  repository: string
}

const RULE = 'K9'
const SCHEMES = ['dark', 'light'] as const
const CSP_VIOLATION = /Content Security Policy/u
const SETTLE_MS = 15_000
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
}

// The file a request names under the base path, as the site's host serves it with clean URLs: a directory's
// index.html, or the path with .html appended.
const fileFor = (built: string, basePath: string, url: string): string | null => {
  const { pathname } = new URL(url, 'http://k9.invalid')
  if (!pathname.startsWith(basePath)) {
    return null
  }
  const path = join(built, decodeURIComponent(pathname.slice(basePath.length)))
  const candidates = pathname.endsWith('/') ? [join(path, 'index.html')] : [path, `${path}.html`]
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
}

const respond = async (file: string, response: ServerResponse): Promise<void> => {
  try {
    const body = await readFile(file)
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body)
  } catch {
    response.writeHead(500).end()
  }
}

// The built site on 127.0.0.1 at a free port, under its base path.
const serve = async (built: string, basePath: string): Promise<{ server: Server; origin: string }> => {
  const server = createServer((request, response) => {
    const file = fileFor(built, basePath, request.url ?? '/')
    if (file === null) {
      response.writeHead(404).end()
      return
    }
    respond(file, response).catch(() => undefined)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` }
}

// The page path of a built HTML file: index.html is its directory, any other file drops .html.
const pagePathOf = (file: string): string =>
  file.endsWith('index.html') ? `/${file.slice(0, -'index.html'.length)}` : `/${file.slice(0, -'.html'.length)}`

// Opens the page in one scheme, opens the search and scrolls it through, so lazy parts such as the search index and
// the diagrams load, and returns every request to another origin and every policy violation it met.
const visit = async (
  browser: Browser,
  origin: string,
  url: string,
  scheme: (typeof SCHEMES)[number]
): Promise<string[]> => {
  const context = await browser.newContext({ colorScheme: scheme })
  try {
    const page = await context.newPage()
    const problems: string[] = []
    await page.route('**/*', async (route) => {
      const target = route.request().url()
      if (new URL(target).origin === origin || target.startsWith('data:')) {
        await route.continue()
        return
      }
      problems.push(`asked another origin: ${target}`)
      await route.abort()
    })
    page.on('console', (message) => {
      if (CSP_VIOLATION.test(message.text())) {
        problems.push(`broke its Content Security Policy: ${message.text()}`)
      }
    })
    await page.goto(url, { waitUntil: 'networkidle', timeout: SETTLE_MS })
    const search = page.locator('.VPNavBarSearch button').first()
    if ((await search.count()) > 0) {
      await search.click()
      await page.keyboard.press('Escape')
    }
    await page.evaluate(async () => {
      // Half a screen at a time, so every lazy part passes through the viewport.
      const step = window.innerHeight / 2
      const scrollFrom = async (top: number): Promise<void> => {
        if (top >= document.body.scrollHeight) {
          return
        }
        window.scrollTo(0, top)
        await new Promise((resolve) => setTimeout(resolve, 50))
        await scrollFrom(top + step)
      }
      await scrollFrom(0)
    })
    await page.waitForLoadState('networkidle', { timeout: SETTLE_MS })
    return problems
  } finally {
    await context.close()
  }
}

// Every built page, served under the base path and opened in headless Chromium in the dark and the light scheme, loads
// nothing from another origin and breaks no Content Security Policy. A finding names the page and the URL or the
// directive.
export const checkK9 = async ({ built, basePath, repository }: IK9Inputs): Promise<IFinding[]> => {
  const files = (await readdir(built, { recursive: true }))
    .map((path) => path.split('\\').join('/'))
    .filter((path) => path.endsWith('.html'))
    .toSorted()
  const { server, origin } = await serve(built, basePath)
  const browser = await chromium.launch({ headless: true })
  // One page and scheme after another, each in a context of its own.
  const visits = files.flatMap((file) => SCHEMES.map((scheme) => ({ file, scheme })))
  try {
    return await visits.reduce<Promise<IFinding[]>>(async (done, { file, scheme }) => {
      const findings = await done
      const pagePath = pagePathOf(file)
      const problems = await visit(browser, origin, `${origin}${basePath}${pagePath.slice(1)}`, scheme)
      return [
        ...findings,
        ...problems.map((problem) => ({
          rule: RULE,
          file: relative(repository, join(built, file)),
          line: 1,
          message: `${pagePath} (${scheme}) ${problem}`,
        })),
      ]
    }, Promise.resolve([]))
  } finally {
    await browser.close()
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
}
