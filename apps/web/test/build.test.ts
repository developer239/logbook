import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderSet, type IServedPage } from './rendered-pages'

const CLIENT = fileURLToPath(new URL('../dist/client', import.meta.url))

interface IStylesheet {
  // Where the stylesheet is served from, which its relative URLs resolve against.
  path: string
  css: string
}

// The origin the stylesheets are checked against: one a handler served the pages from.
const ORIGIN = 'http://127.0.0.1'

let directory = ''
let pages: IServedPage[] = []
let stylesheets: IStylesheet[] = []

const filesBelow = async (root: string): Promise<string[]> =>
  (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))

const isOwnOrigin = (url: string, origin: string, path: string): boolean =>
  new URL(url, `${origin}${path}`).origin === origin

// What a page asks the browser to fetch: every src, every <link> href and every form action.
const requestsOf = (html: string): string[] =>
  [
    ...html.matchAll(/\ssrc="(?<url>[^"]*)"/gu),
    ...[...html.matchAll(/<link\b[^>]*>/gu)].flatMap((link) => [...link[0].matchAll(/\shref="(?<url>[^"]*)"/gu)]),
    ...[...html.matchAll(/<form\b[^>]*>/gu)].flatMap((form) => [...form[0].matchAll(/\saction="(?<url>[^"]*)"/gu)]),
  ].map((match) => match.groups?.url ?? '')

// What CSS asks the browser to fetch: every url() and every @import.
const cssRequestsOf = (css: string): string[] =>
  [
    ...css.matchAll(/url\(\s*(?<quote>["']?)(?<url>[^"')]*)\k<quote>\s*\)/gu),
    ...css.matchAll(/@import\s+(?<quote>["'])(?<url>[^"']*)\k<quote>/gu),
  ].map((match) => match.groups?.url ?? '')

// The CSS a page carries itself: its <style> elements and style attributes.
const inlineCssOf = (html: string): string[] => [
  ...[...html.matchAll(/<style\b[^>]*>(?<css>[\s\S]*?)<\/style>/gu)].map((match) => match.groups?.css ?? ''),
  ...[...html.matchAll(/\sstyle="(?<css>[^"]*)"/gu)].map((match) => match.groups?.css ?? ''),
]

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'web-build-'))
  // One set is mounted at a time.
  const variant = await renderSet('demoSmallNoLabels', directory)
  pages = [...variant, ...(await renderSet('demoSmall', directory))]
  stylesheets = await Promise.all(
    (await filesBelow(CLIENT))
      .filter((file) => file.endsWith('.css'))
      .map(async (file) => ({ path: `/${relative(CLIENT, file)}`, css: await readFile(file, 'utf8') }))
  )
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('the build', () => {
  it('renders the pages it is checked over, and ships stylesheets', () => {
    expect({ pages: pages.every((page) => page.status === 200), stylesheets: stylesheets.length > 0 }).toStrictEqual({
      pages: true,
      stylesheets: true,
    })
  })

  it('holds no <script> element without a src', () => {
    expect(
      pages.flatMap((page) =>
        [...page.body.matchAll(/<script\b(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/gu)].map((script) => [
          page.path,
          script[0],
        ])
      )
    ).toStrictEqual([])
  })

  it('asks for every script, stylesheet and form target on its own origin', () => {
    expect(
      pages.flatMap((page) =>
        requestsOf(page.body)
          .filter((url) => !isOwnOrigin(url, page.origin, page.path))
          .map((url) => [page.path, url])
      )
    ).toStrictEqual([])
  })

  it("asks for every CSS url() and @import on its own origin, its stylesheets' and its pages' alike", () => {
    expect([
      ...stylesheets.flatMap((sheet) =>
        cssRequestsOf(sheet.css)
          .filter((url) => !isOwnOrigin(url, ORIGIN, sheet.path))
          .map((url) => [sheet.path, url])
      ),
      ...pages.flatMap((page) =>
        inlineCssOf(page.body)
          .flatMap(cssRequestsOf)
          .filter((url) => !isOwnOrigin(url, page.origin, page.path))
          .map((url) => [page.path, url])
      ),
    ]).toStrictEqual([])
  })

  it('loads its fonts from the files in fonts/', () => {
    const fonts = stylesheets.flatMap((sheet) =>
      cssRequestsOf(sheet.css)
        .filter((url) => /\.(?:woff2?|ttf|otf)$/u.test(url))
        .map((url) => new URL(url, `${ORIGIN}${sheet.path}`).pathname)
    )

    expect({
      outside: fonts.filter((path) => !path.startsWith('/fonts/') || !existsSync(join(CLIENT, path))),
      isAny: fonts.length > 0,
    }).toStrictEqual({ outside: [], isAny: true })
  })
})
