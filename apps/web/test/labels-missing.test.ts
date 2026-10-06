import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountBuiltHandler, type IBuiltHandler } from './built-handler'

const PANEL =
  'These need labels from a model. Open Label to see what a run would send and start it, or run logbook labels update in a terminal. Rules-based labels are already shown.'
const CARDS = [
  "Didn't finish",
  'Conversations by goal',
  'Tokens per conversation',
  'Reactions to the agent',
  'Reactions from the agent',
]
const AT = Date.UTC(2026, 9, 5, 12)

let warehouse: ITestWarehouse
let built: IBuiltHandler

const textOf = (html: string): string =>
  html
    .replaceAll(/<[^>]+>/gu, ' ')
    .replaceAll('&#39;', "'")
    .replaceAll(/\s+/gu, ' ')
    .trim()

// Each card that needs model labels: its panel's text and link, or null where it shows its data.
const dashboard = async (): Promise<{ cards: Record<string, unknown>; finished: string }> => {
  const body = await (await fetch(`${built.origin}/?range=all`)).text()
  const cards = Object.fromEntries(
    CARDS.map((title) => {
      const card = new RegExp(
        `<h3 class="card__title">${title.replace("'", '&#39;')}</h3>[\\s\\S]*?</section>`,
        'u'
      ).exec(body)?.[0]
      const panel = /<p class="labels-missing">[\s\S]*?<\/p>/u.exec(card ?? '')?.[0]
      return [
        title,
        panel === undefined ? null : { text: textOf(panel), href: /href="(?<href>[^"]+)"/u.exec(panel)?.groups?.href },
      ]
    })
  )
  const finished = /Finished[\s\S]*?<span class="strip__sub">(?<sub>[^<]*)<\/span>/u.exec(body)?.groups?.sub ?? ''
  return { cards, finished }
}

const run = (done: number): void => {
  insert(warehouse.db, 'label_run', {
    id: 1,
    pid: 999_999,
    started_at: AT,
    ended_at: AT + 1000,
    outcome: 'ok',
    model: 'claude-haiku-4-5',
  })
  insert(warehouse.db, 'label_run_task', { run_id: 1, task: 'outcome', version: 1, planned: 1, done })
}

beforeAll(async () => {
  warehouse = await createTestWarehouse()
  insert(warehouse.db, 'session', {
    id: 'example:demo-0001',
    harness: 'example',
    source_id: 'demo-0001',
    origin: 'interactive',
    is_scripted: 0,
    title: 'Rename the release script',
    started_at: AT,
    ended_at: AT + 60_000,
  })
  // A label the rules gave, as every sync writes them.
  insert(warehouse.db, 'label', {
    record_type: 'session',
    record_id: 'example:demo-0001',
    labeller: 'rules',
    version: 1,
    name: 'origin',
    value: 'interactive',
    labelled_at: AT,
  })
  vi.stubEnv('LOGBOOK_DB', warehouse.path)
  built = await mountBuiltHandler()
})

afterEach(() => {
  warehouse.db.exec("DELETE FROM label_run_task; DELETE FROM label_run; DELETE FROM label WHERE labeller <> 'rules'")
})

afterAll(async () => {
  await built.close()
  vi.unstubAllEnvs()
  await warehouse.remove()
})

describe('the cards that need model labels, in the built handler', () => {
  it('show the panel with its Label link, and the strip says not labelled yet, while only rules have labelled', async () => {
    // Act
    const shown = await dashboard()

    // Assert
    expect(shown).toStrictEqual({
      cards: Object.fromEntries(CARDS.map((title) => [title, { text: PANEL, href: '/labels' }])),
      finished: 'not labelled yet',
    })
  })

  it('show their data and no panel once a run has labelled something', async () => {
    // Arrange
    run(1)
    insert(warehouse.db, 'label', {
      record_type: 'session',
      record_id: 'example:demo-0001',
      labeller: 'claude-haiku-4-5',
      version: 1,
      name: 'outcome',
      value: 'done',
      labelled_at: AT + 1000,
    })

    // Act
    const shown = await dashboard()

    // Assert
    expect(shown).toStrictEqual({
      cards: Object.fromEntries(CARDS.map((title) => [title, null])),
      finished: '100% of 1 done',
    })
  })

  it('still show the panel after a run that stopped before its first batch', async () => {
    // Arrange
    run(0)

    // Act
    const shown = await dashboard()

    // Assert
    expect(shown.cards).toStrictEqual(
      Object.fromEntries(CARDS.map((title) => [title, { text: PANEL, href: '/labels' }]))
    )
  })
})
