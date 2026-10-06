import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ISessionScript } from '@log-book/adapter-api/source-writer'
import { inventedAdapter } from '@log-book/adapter-api/testing'
import claudeCode from '@log-book/adapter-claude-code'
import { claudeCodeSourceWriter } from '@log-book/adapter-claude-code/source-writer'
import openCode from '@log-book/adapter-opencode'
import { openCodeSourceWriter } from '@log-book/adapter-opencode/source-writer'
import { openSqlite } from '@log-book/core'
import { createEngine } from '@log-book/engine'
import { handler } from '@log-book/web'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The third adapter's id, which only links and element ids may show.
const INVENTED_ID = 'test-harness'
const AT = Date.UTC(2026, 8, 28, 9)
const MINUTE = 60_000

// A session that opens with one prompt and one reply, in an invented project under the writers' script home.
const scriptOf = (key: string, prompt: string, at: number): ISessionScript => ({
  key,
  projectDir: '/home/example/work/shop',
  title: null,
  agent: null,
  gitBranch: null,
  isScripted: false,
  harnessVersion: null,
  steps: [
    { kind: 'prompt', key: `${key}-prompt`, at, text: prompt, images: 0 },
    {
      kind: 'reply',
      key: `${key}-reply`,
      at: at + MINUTE,
      endAt: at + 2 * MINUTE,
      model: 'model-a',
      text: 'Done.',
      reasoning: null,
      tokens: null,
      cost: null,
    },
  ],
})

const CLAUDE_CODE_PROMPT = 'check the shop build'
const OPENCODE_PROMPT = 'rename the billing export'
const INVENTED_TITLE = 'Tidy the release notes'

// The registered adapters of this test alone: the two real ones and the invented third, with its own display name and
// filter alias. The CLI's own list never holds it.
const ADAPTERS = [
  claudeCode(),
  openCode(),
  inventedAdapter({
    name: 'Example Harness',
    filterAlias: 'example',
    listing: {
      kind: 'units',
      units: [
        {
          locator: 'notes-1',
          sessions: [
            {
              projectDir: '/home/example/work/docs',
              title: INVENTED_TITLE,
              messages: [
                { actor: 'user', text: 'tidy the release notes', at: AT + 20 * MINUTE },
                { actor: 'assistant', text: 'The notes are tidy.', at: AT + 21 * MINUTE },
              ],
            },
          ],
        },
      ],
    },
  }),
] as const

const directories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => {
            resolve()
          })
        })
    )
  )
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

// The adapters find their files only in this home, and the warehouse and the web app's reads stay in the directory.
const isolate = (directory: string): { home: string; warehouse: string } => {
  const home = join(directory, 'home')
  const warehouse = join(directory, 'warehouse.db')
  vi.stubEnv('HOME', home)
  vi.stubEnv('LOGBOOK_DB', warehouse)
  for (const variable of [
    'CLAUDE_CONFIG_DIR',
    'OPENCODE_DB',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_DISABLE_CHANNEL_DB',
    'XDG_DATA_HOME',
    'XDG_CONFIG_HOME',
  ]) {
    vi.stubEnv(variable, '')
  }
  return { home, warehouse }
}

const sessionsByHarness = async (warehouse: string): Promise<Record<string, number>> => {
  const db = await openSqlite(warehouse, { isReadOnly: true })
  try {
    const rows = db.prepare('SELECT harness, count(*) AS sessions FROM session GROUP BY harness').all() as {
      harness: string
      sessions: number
    }[]
    return Object.fromEntries(rows.map(({ harness, sessions }) => [harness, sessions]))
  } finally {
    db.close()
  }
}

// The built web handler on 127.0.0.1, reading the warehouse LOGBOOK_DB names.
const mountHandler = async (): Promise<string> => {
  const server = createServer((req, res) => {
    Promise.resolve(
      handler(req, res, () => {
        res.statusCode = 404
        res.end()
      })
    ).catch((error: unknown) => {
      res.statusCode = 500
      res.end(String(error))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

const page = async (origin: string, path: string): Promise<string> => {
  const response = await fetch(`${origin}${path}`)
  return response.status === 200 ? response.text() : `status ${String(response.status)}`
}

// A page's text with what may name the id taken out: link targets, element ids and the search box echoing its query.
const outsideLinksAndIds = (html: string): string =>
  html.replace(/\s(?:href|id|for|aria-controls|aria-labelledby|aria-describedby|value)="[^"]*"/gu, '')

const shows = (html: string): Record<string, boolean> => ({
  claudeCode: html.includes(CLAUDE_CODE_PROMPT) && html.includes(claudeCode().descriptor.name),
  openCode: html.includes(OPENCODE_PROMPT) && html.includes(openCode().descriptor.name),
  invented: html.includes(INVENTED_TITLE) && html.includes('Example Harness'),
  // The id is in the page, in the links to the invented conversation, and nowhere else.
  isIdInPage: html.includes(INVENTED_ID),
  inventedId: outsideLinksAndIds(html).includes(INVENTED_ID),
})

describe('a third adapter', () => {
  it('syncs beside the real adapters and reads through the web app by its name and alias, with no change to either', async () => {
    // Arrange
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'third-adapter-')))
    directories.push(directory)
    const { home, warehouse } = isolate(directory)
    await mkdir(home)
    await claudeCodeSourceWriter().writeSessions(home, [scriptOf('cc-1', CLAUDE_CODE_PROMPT, AT)])
    await openCodeSourceWriter().writeSessions(home, [scriptOf('oc-1', OPENCODE_PROMPT, AT + 10 * MINUTE)])
    const result = await createEngine({ adapters: ADAPTERS, warehousePath: warehouse }).sync({
      signal: new AbortController().signal,
    })
    const origin = await mountHandler()

    // Act
    const [all, byAlias, byId] = [
      await page(origin, '/conversations?range=all'),
      await page(origin, '/conversations?range=all&q=harness%3Aexample'),
      await page(origin, `/conversations?range=all&q=harness%3A${INVENTED_ID}`),
    ]

    // Assert
    expect({
      outcome: result.outcome,
      sessions: await sessionsByHarness(warehouse),
      all: shows(all),
      byAlias: shows(byAlias),
      byId: shows(byId),
    }).toStrictEqual({
      outcome: 'ok',
      sessions: { [claudeCode().descriptor.id]: 1, [openCode().descriptor.id]: 1, [INVENTED_ID]: 1 },
      all: { claudeCode: true, openCode: true, invented: true, isIdInPage: true, inventedId: false },
      byAlias: { claudeCode: false, openCode: false, invented: true, isIdInPage: true, inventedId: false },
      byId: { claudeCode: false, openCode: false, invented: true, isIdInPage: true, inventedId: false },
    })
  })
})
