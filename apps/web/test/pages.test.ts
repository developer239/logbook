import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { logbookStub, type ILogbookStub } from '../src/lib/testing/logbook-stub'
import {
  answerPlan,
  mountSet,
  render,
  renderSet,
  routesOf,
  type IMountedSet,
  type IRenderedPage,
} from './rendered-pages'

// The panel's text as spec 07 words it, on each dashboard card that needs model labels.
const PANEL =
  'These need labels from a model. Open Label to see what a run would send and start it, or run logbook labels update in a terminal. Rules-based labels are already shown.'
const CARDS = [
  "Didn't finish",
  'Conversations by goal',
  'Tokens per conversation',
  'Reactions to the agent',
  'Reactions from the agent',
]

interface IHarness {
  id: string
  name: string
}

let directory = ''
let stub: ILogbookStub
let small: IMountedSet
let harnesses: IHarness[] = []
let pages: IRenderedPage[] = []
let variantPages: IRenderedPage[] = []

const textOf = (html: string): string =>
  html
    .replaceAll(/<[^>]+>/gu, ' ')
    .replaceAll('&#39;', "'")
    .replaceAll(/\s+/gu, ' ')
    .trim()

// A page without its element ids and the URLs it names (a path, a query or a fragment), and without the records' ids:
// a record's id is its harness's id, a colon and the source's id, wherever the page shows it or marks an element by it.
const withoutIdsAndUrls = (html: string): string =>
  harnesses.reduce(
    (text, harness) => text.replaceAll(new RegExp(`${harness.id}:[^\\s"<]+`, 'gu'), ' '),
    html.replaceAll(/\s(?:id="[^"]*"|[a-z-]+="(?:[/?#]|https?:)[^"]*")/gu, ' ')
  )

// The set without model labels is rendered and closed first, as one set is mounted at a time; the small set stays
// mounted for the tests that ask it more.
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'web-pages-'))
  variantPages = await renderSet('demoSmallNoLabels', directory)
  stub = await logbookStub(directory)
  small = await mountSet('demoSmall')
  answerPlan(stub, small.warehouse)
  harnesses = small.warehouse.db.prepare('SELECT id, name FROM harness ORDER BY id').all() as IHarness[]
  pages = await render(small.built.origin, routesOf(small.demo))
})

afterAll(async () => {
  await small.close()
  await rm(directory, { recursive: true, force: true })
})

describe('every page over the built handler', () => {
  it('answers 200 on every route of either set', () => {
    expect([...pages, ...variantPages].map((page) => [page.path, page.status])).toStrictEqual(
      [...routesOf(small.demo), ...routesOf(inject('demoSmallNoLabels'))].map((path) => [path, 200])
    )
  })

  it('answers 404 for a session the warehouse does not have, and 400 for a range it cannot read', async () => {
    const replies = await render(small.built.origin, ['/conversations/nope%3Anone?range=all', '/?range=nope'])

    expect(replies.map((reply) => reply.status)).toStrictEqual([404, 400])
  })

  it('names each harness by its display name and holds no harness id outside element ids and URLs', () => {
    const list = pages.find((page) => page.path.startsWith('/conversations?'))?.body ?? ''

    expect({
      ids: [...pages, ...variantPages].flatMap((page) =>
        harnesses
          .filter((harness) => withoutIdsAndUrls(page.body).includes(harness.id))
          .map((harness) => [page.path, harness.id])
      ),
      names: harnesses.map((harness) => textOf(list).includes(harness.name)),
      isAny: harnesses.length > 0,
    }).toStrictEqual({ ids: [], names: harnesses.map(() => true), isAny: true })
  })

  it('shows the "not labelled yet" panel on each card that needs model labels on the set without them', () => {
    const dashboard = variantPages[0]?.body ?? ''

    const panels = CARDS.map((title) => {
      const card = new RegExp(
        `<h3 class="card__title">${title.replace("'", '&#39;')}</h3>[\\s\\S]*?</section>`,
        'u'
      ).exec(dashboard)?.[0]
      const panel = /<p class="labels-missing">[\s\S]*?<\/p>/u.exec(card ?? '')?.[0]
      return panel === undefined ? null : textOf(panel)
    })

    expect(panels).toStrictEqual(CARDS.map(() => PANEL))
  })

  it('answers 404 for the routes the first release dropped, and runs no logbook for them', async () => {
    const before = await stub.calls()

    const replies = [
      await fetch(`${small.built.origin}/rules`),
      await fetch(`${small.built.origin}/check`),
      await fetch(`${small.built.origin}/verdict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': small.built.origin },
        body: 'verdict=yes',
      }),
    ]

    expect({ statuses: replies.map((reply) => reply.status), calls: await stub.calls() }).toStrictEqual({
      statuses: [404, 404, 404],
      calls: before,
    })
  })
})
