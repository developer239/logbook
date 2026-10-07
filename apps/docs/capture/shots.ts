import type { IStartedDemo } from '@log-book/demo'

export type DemoPlan = IStartedDemo['plan']
export type Scheme = 'dark' | 'light'
export type BuildName = 'rich' | 'not-labelled'

// Where a shot opens: a path of the web app, the plan's showcase conversation, or the page a link of another page
// leads to.
export type ShotPage =
  | { kind: 'path'; path: string }
  | { kind: 'showcase' }
  | { kind: 'follow'; path: string; link: string }

// A range preset of the web app's `range` parameter, and how the page names it.
interface IShotRange {
  key: string
  label: string
}

export interface IShot {
  id: string
  page: ShotPage
  range: IShotRange | null
  build: BuildName
  viewport: readonly [number, number]
  // Texts of the web app's own copy that must be visible before the capture.
  expect: readonly string[]
  // What the image shows, for its alt text.
  alt: string
  // The element an element shot captures; null for the viewport.
  selector: string | null
  // A turn of the conversation, by its number from 1, scrolled under the reading line before the capture.
  turn: number | null
  // The state panel the shot shows on purpose.
  shows: 'not-labelled' | null
}

const DESKTOP = [1440, 900] as const
const THIRTY_DAYS: IShotRange = { key: '30d', label: '30 days' }
// The small set's anchor is fixed and lies in the past, so only the whole range shows its data.
const ALL_TIME: IShotRange = { key: 'all', label: 'All time' }
const NOT_LABELLED_TEXT = 'These need labels from a model.'

// A dashboard card, by its title.
export const card = (title: string): string => `section.card:has(h3.card__title:text-is("${title}"))`

const shot = (fields: Pick<IShot, 'id' | 'page' | 'expect' | 'alt'> & Partial<IShot>): IShot => ({
  range: null,
  build: 'rich',
  viewport: DESKTOP,
  selector: null,
  turn: null,
  shows: null,
  ...fields,
})

// Every shot of the site, each captured in the dark and the light scheme.
export const SHOTS: readonly IShot[] = [
  shot({
    id: 'dashboard',
    page: { kind: 'path', path: '/' },
    range: THIRTY_DAYS,
    expect: ['Tool problems', 'Reactions to the agent', 'Reactions from the agent'],
    alt: "The dashboard over 30 days: tool problems, time per turn, the agent's and the developer's reactions, and tokens",
  }),
  shot({
    id: 'conversations',
    page: { kind: 'path', path: '/conversations' },
    expect: ['Conversations'],
    alt: 'The list of conversations, newest first, with their goals and outcomes',
  }),
  shot({
    id: 'conversation',
    page: { kind: 'showcase' },
    expect: ['Turn 01'],
    alt: 'A conversation from its top: the session map, the thread of turns and the Turn pane',
  }),
  shot({
    id: 'turn-pane',
    page: { kind: 'showcase' },
    turn: 12,
    expect: ['Turn 12', 'pnpm test', 'failed with a real result'],
    alt: 'The Turn pane of a turn whose test run failed three times before it passed',
  }),
  shot({
    id: 'steps',
    page: { kind: 'follow', path: '/', link: `${card('Tool problems')} li.rows__row a` },
    range: THIRTY_DAYS,
    expect: ['Failed: '],
    alt: 'The failed steps of the most common cause, followed from the Tool problems card',
  }),
  shot({
    id: 'tokens',
    page: { kind: 'path', path: '/tokens' },
    expect: ['Tokens by tool'],
    alt: 'Tokens by tool',
  }),
  shot({
    id: 'not-labelled',
    page: { kind: 'path', path: '/' },
    build: 'not-labelled',
    range: ALL_TIME,
    shows: 'not-labelled',
    expect: [NOT_LABELLED_TEXT],
    alt: 'The dashboard before any model labels: the cards that need them say so',
  }),
  shot({
    id: 'sync-control',
    page: { kind: 'path', path: '/' },
    selector: 'header.top-bar',
    expect: ['Dashboard', 'Conversations'],
    alt: 'The top bar with the Sync button and the Label control',
  }),
  shot({
    id: 'reactions-card',
    page: { kind: 'path', path: '/' },
    selector: card('Reactions to the agent'),
    expect: ['Reactions to the agent'],
    alt: "The Reactions to the agent card: the developer's corrections and praise, week by week",
  }),
  shot({
    id: 'agent-reactions',
    page: { kind: 'path', path: '/' },
    selector: card('Reactions from the agent'),
    expect: ['Reactions from the agent'],
    alt: 'The Reactions from the agent card: how often each model asks, holds or caves',
  }),
]

export const SCHEMES: readonly Scheme[] = ['dark', 'light']

// The texts each state panel shows, which no shot may show unless it asks for that state.
export const PANELS = {
  error: { selector: '.page-problem', name: 'an error panel' },
  firstRun: { selector: 'section.first-run', name: 'a first-run panel' },
  notLabelled: { selector: 'p.labels-missing', name: `the "not labelled yet" panel (${NOT_LABELLED_TEXT} ...)` },
} as const

const withRange = (path: string, range: IShotRange | null): string =>
  range === null ? path : `${path}?${new URLSearchParams({ range: range.key }).toString()}`

export const showcasePath = (plan: DemoPlan): string => {
  if (plan.showcase === null) {
    throw new Error('The plan holds no showcase conversation')
  }
  return `/conversations/${encodeURIComponent(plan.showcase.id)}`
}

// The path a shot opens first, built from the plan; a followed shot then moves on to its link's target.
export const pathOf = (page: ShotPage, range: IShotRange | null, plan: DemoPlan): string =>
  withRange(page.kind === 'showcase' ? showcasePath(plan) : page.path, range)
