import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import {
  CaptureError,
  guarded,
  SETTLE_MS,
  sha256,
  textOf,
  turnTarget,
  unwantedPanels,
  waitForTexts,
  waitForTurnPane,
} from './capture.js'
import { card, showcasePath, type DemoPlan } from './shots.js'

const run = promisify(execFile)
// The package is CommonJS and exports the binary's path, or null on a platform it has no build for; its declarations
// describe an ES default export instead, so it is read as what it is.
const require = createRequire(import.meta.url)
const FFMPEG: unknown = require('ffmpeg-static')

export type VideoId = 'tour' | 'conversation-scroll'

// A text capture of a page the video visits, by its order in the video.
interface IVideoText {
  file: string
  sha256: string
  page: string
}

export interface IVideoRecord {
  file: string
  sha256: string
  video: VideoId
  scheme: 'dark'
  build: 'rich'
  viewport: readonly [number, number]
  // The capture the site shows before the video plays.
  poster: string
  texts: IVideoText[]
}

// A place in the viewport, in CSS pixels from its top left corner.
interface IPoint {
  left: number
  top: number
}

// One video being recorded: its page, where the pointer rests, and the text of every page it visited so far.
interface IRecording {
  page: Page
  host: string
  plan: DemoPlan
  settleMs: number
  // The unit of every pause and glide; 0 records at the page's own pace.
  beatMs: number
  problems: string[]
  pointer: IPoint
  texts: { page: string; text: string }[]
}

export interface IVideo {
  id: VideoId
  poster: string
  record: (recording: IRecording) => Promise<void>
}

const VIEWPORT = [1280, 800] as const
// The mouse moves in this many events between two points, so the drawn pointer travels rather than jumps.
const POINTER_STEPS = 30
// Where a card or turn the video points at stands, as a share of the viewport's height from its top.
const CARD_LINE = 0.2
// The demo places the showcase conversation in it on every build.
const SEVEN_DAYS = '7d'

// The pointer Playwright's video does not show: one element without text or link that follows the mouse and rings on a
// click. Its styles are style properties, which a Content Security Policy without 'unsafe-inline' still allows. It runs
// in the page, so it uses nothing of this module.
const drawPointer = (): void => {
  const pointer = document.createElement('div')
  Object.assign(pointer.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '1.125rem',
    height: '1.125rem',
    margin: '-0.5625rem 0 0 -0.5625rem',
    borderRadius: '50%',
    background: 'rgba(255, 255, 255, 0.85)',
    border: '2px solid rgba(0, 0, 0, 0.6)',
    boxShadow: '0 0 0 0 rgba(255, 255, 255, 0.5)',
    transition: 'box-shadow 0.2s ease-out',
    transform: 'translate(-100px, -100px)',
    pointerEvents: 'none',
    zIndex: '2147483647',
  })
  document.addEventListener(
    'mousemove',
    (event) => {
      pointer.style.transform = `translate(${String(event.clientX)}px, ${String(event.clientY)}px)`
    },
    true
  )
  document.addEventListener(
    'mousedown',
    () => {
      pointer.style.boxShadow = '0 0 0 0.75rem rgba(255, 255, 255, 0.35)'
    },
    true
  )
  document.addEventListener(
    'mouseup',
    () => {
      pointer.style.boxShadow = '0 0 0 0 rgba(255, 255, 255, 0.5)'
    },
    true
  )
  // Outside the body, so the page's text is the same with it as without it.
  const attach = (): void => {
    document.documentElement.append(pointer)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach)
  } else {
    attach()
  }
}

// Every page of the context draws the pointer.
export const addPointer = async (context: BrowserContext): Promise<void> => {
  await context.addInitScript(drawPointer)
}

// Runs the step for each item, one after another, as a video plays them.
const inTurn = async <TItem>(items: readonly TItem[], step: (item: TItem) => Promise<void>): Promise<void> =>
  items.reduce<Promise<void>>(async (done, item) => {
    await done
    await step(item)
  }, Promise.resolve())

const rest = async (recording: IRecording, beats: number): Promise<void> => {
  await recording.page.waitForTimeout(beats * recording.beatMs)
}

const moveTo = async (recording: IRecording, point: IPoint): Promise<void> => {
  await recording.page.mouse.move(point.left, point.top, { steps: POINTER_STEPS })
  recording.pointer = point
}

// Scrolls the window to the position over the given beats, easing in and out, as a reader's wheel would.
const glide = async (recording: IRecording, top: number, beats: number): Promise<void> => {
  await recording.page.evaluate(
    async ({ target, ms }) =>
      new Promise<void>((resolve) => {
        const from = window.scrollY
        const started = performance.now()
        const frame = (now: number): void => {
          const progress = ms === 0 ? 1 : Math.min(1, (now - started) / ms)
          const eased = progress < 0.5 ? 2 * progress ** 2 : 1 - (-2 * progress + 2) ** 2 / 2
          window.scrollTo({ top: from + (target - from) * eased, behavior: 'instant' })
          if (progress < 1) {
            requestAnimationFrame(frame)
          } else {
            resolve()
          }
        }
        requestAnimationFrame(frame)
      }),
    { target: top, ms: beats * recording.beatMs }
  )
}

// The page has loaded: it shows the texts, no other origin was asked and no policy was broken, it shows no state
// panel, the pointer is drawn where it rested, and its text is kept.
const arrive = async (recording: IRecording, expect: readonly string[]): Promise<void> => {
  const { page } = recording
  await waitForTexts(page, expect, recording.settleMs)
  const found = [...recording.problems, ...(await unwantedPanels(page, null))]
  if (found.length > 0) {
    throw new CaptureError(found.join('; '))
  }
  await page.mouse.move(recording.pointer.left, recording.pointer.top)
  const url = new URL(page.url())
  recording.texts.push({ page: `${url.pathname}${url.search}`, text: await textOf(page) })
}

const visit = async (recording: IRecording, path: string, expect: readonly string[]): Promise<void> => {
  await recording.page.goto(new URL(path, recording.host).href, { waitUntil: 'networkidle' })
  await arrive(recording, expect)
}

type Box = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>

const boxOf = async (locator: Locator, name: string): Promise<Box> => {
  const box = await locator.boundingBox()
  if (box === null) {
    throw new CaptureError(`the page does not show ${name}`)
  }
  return box
}

// Brings the element to the card line, then moves the pointer to its middle.
const pointAt = async (recording: IRecording, locator: Locator, name: string): Promise<void> => {
  const { page } = recording
  const box = await boxOf(locator, name)
  const scrollY = await page.evaluate(() => window.scrollY)
  await glide(recording, Math.max(0, box.y + scrollY - VIEWPORT[1] * CARD_LINE), 1.5)
  const shown = await boxOf(locator, name)
  await moveTo(recording, { left: shown.x + shown.width / 2, top: shown.y + Math.min(shown.height / 2, 40) })
}

// Points at the link and clicks it, then waits for the page it opens.
const follow = async (recording: IRecording, link: Locator, name: string, expect: readonly string[]): Promise<void> => {
  const { page } = recording
  const href = await link.getAttribute('href')
  if (href === null) {
    throw new CaptureError(`${name} has no href`)
  }
  const target = new URL(href, page.url()).pathname
  await pointAt(recording, link, name)
  await rest(recording, 0.5)
  await Promise.all([
    page.waitForURL((url) => url.pathname === target, { waitUntil: 'networkidle', timeout: recording.settleMs }),
    page.mouse.down().then(async () => page.mouse.up()),
  ])
  await arrive(recording, expect)
}

// Glides the thread until the turn is under the reading line and waits until the Turn pane follows it.
const readTurn = async (recording: IRecording, turn: number, beats: number): Promise<void> => {
  const { turnId, top } = await turnTarget(recording.page, turn)
  await glide(recording, top, beats)
  await waitForTurnPane(recording.page, turnId, recording.settleMs)
}

// The showcase conversation's page and the project it belongs to, from the plan.
const showcaseOf = (plan: DemoPlan): { path: string; project: string } => {
  const path = showcasePath(plan)
  const session = plan.plan.sessions.find((candidate) => candidate.key === plan.showcase?.key)
  if (session === undefined) {
    throw new CaptureError('the plan holds no session for its showcase conversation')
  }
  return { path, project: session.project }
}

const TIME_PER_TURN = 'Time per turn'
const REACTIONS_TO = 'Reactions to the agent'
const REACTIONS_FROM = 'Reactions from the agent'
// The turns the tour stops at: the correction under turn 4's prompt, the interrupted commit, the retry loop.
const TOUR_TURNS = [4, 6, 12] as const
const SCROLL_TURNS = 14

// The tour, under a minute: the dashboard, the conversations of the showcase's project, the showcase conversation read
// through its turns, and back to the dashboard's reaction cards.
const tour = async (recording: IRecording): Promise<void> => {
  const { page, plan } = recording
  const showcase = showcaseOf(plan)
  await visit(recording, `/?${new URLSearchParams({ range: SEVEN_DAYS }).toString()}`, [TIME_PER_TURN])
  await rest(recording, 1)
  await pointAt(recording, page.locator(card(TIME_PER_TURN)).first(), `the ${TIME_PER_TURN} card`)
  await rest(recording, 3)

  const filter = new URLSearchParams([['q', `project:${showcase.project}`]])
  await visit(recording, `/conversations?${filter.toString()}`, ['Conversations'])
  await rest(recording, 1.5)
  const row = page.locator(`a[href="${showcase.path}"], a[href^="${showcase.path}?"]`).first()
  await follow(recording, row, `the row of ${showcase.path}`, ['Turn 01'])
  await rest(recording, 2)
  await inTurn(TOUR_TURNS, async (turn) => {
    await readTurn(recording, turn, 2.5)
    await rest(recording, 2.5)
  })

  const dashboard = page.locator('header.top-bar').getByRole('link', { name: 'Dashboard', exact: true }).first()
  await follow(recording, dashboard, 'the Dashboard link', [REACTIONS_TO, REACTIONS_FROM])
  await inTurn([REACTIONS_TO, REACTIONS_FROM], async (title) => {
    await rest(recording, 1)
    await pointAt(recording, page.locator(card(title)).first(), `the ${title} card`)
    await rest(recording, 3)
  })
}

// About 15 seconds: the showcase conversation from its top, read turn by turn with the session map in its time mode.
const conversationScroll = async (recording: IRecording): Promise<void> => {
  const { page, plan } = recording
  await visit(recording, showcasePath(plan), ['Turn 01'])
  if ((await page.locator('[data-map][data-mode="time"]').count()) === 0) {
    throw new CaptureError('the session map is not in its time mode')
  }
  await moveTo(recording, { left: VIEWPORT[0] - 40, top: VIEWPORT[1] - 40 })
  await rest(recording, 1)
  await inTurn(
    Array.from({ length: SCROLL_TURNS }, (_turn, index) => index + 1),
    async (turn) => {
      await readTurn(recording, turn, 0.6)
      await rest(recording, 0.35)
    }
  )
  await rest(recording, 1)
}

// Every video of the site, recorded from the rich build in the dark scheme.
export const VIDEOS: readonly IVideo[] = [
  { id: 'tour', poster: 'dashboard-dark.png', record: tour },
  { id: 'conversation-scroll', poster: 'conversation-dark.png', record: conversationScroll },
]

// H.264 without an audio track, which every browser the site supports plays, starting before the whole file arrives.
const transcode = async (webm: string, mp4: string): Promise<void> => {
  if (typeof FFMPEG !== 'string') {
    throw new CaptureError('ffmpeg-static has no ffmpeg build for this platform')
  }
  await run(FFMPEG, [
    '-y',
    '-loglevel',
    'error',
    '-i',
    webm,
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '28',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    mp4,
  ])
}

export interface IVideoInputs {
  browser: Browser
  host: string
  plan: DemoPlan
  video: IVideo
  directory: string
  // How long to wait for the page; 15 seconds when absent.
  settleMs?: number
  // The unit of every pause and glide; one second when absent.
  beatMs?: number
}

// Plays the video's steps in the context with the pointer drawn, and closes the context, which completes the WebM.
const recordSteps = async (
  context: BrowserContext,
  { host, plan, video, settleMs, beatMs }: Required<Omit<IVideoInputs, 'browser' | 'directory'>>
): Promise<{ texts: IRecording['texts']; webm: string }> => {
  try {
    await addPointer(context)
    const page = await context.newPage()
    const recording: IRecording = {
      page,
      host,
      plan,
      settleMs,
      beatMs,
      problems: await guarded(page, new URL(host).origin),
      pointer: { left: VIEWPORT[0] / 2, top: VIEWPORT[1] / 2 },
      texts: [],
    }
    await video.record(recording)
    if (recording.problems.length > 0) {
      throw new CaptureError(recording.problems.join('; '))
    }
    const webm = await page.video()?.path()
    if (webm === undefined) {
      throw new CaptureError('the context recorded no video')
    }
    return { texts: recording.texts, webm }
  } finally {
    await context.close()
  }
}

// Records the video in a context of its own and writes the MP4 and the text capture of every page it visited into the
// directory, or a CaptureError naming the video and why.
export const recordVideo = async ({
  browser,
  host,
  plan,
  video,
  directory,
  settleMs = SETTLE_MS,
  beatMs = 1000,
}: IVideoInputs): Promise<IVideoRecord> => {
  const [width, height] = VIEWPORT
  const raw = await mkdtemp(join(tmpdir(), 'docs-video-'))
  try {
    const context = await browser.newContext({
      colorScheme: 'dark',
      timezoneId: 'UTC',
      locale: 'en-US',
      viewport: { width, height },
      recordVideo: { dir: raw, size: { width, height } },
    })
    const recorded = await recordSteps(context, { host, plan, video, settleMs, beatMs })
    const file = `${video.id}.mp4`
    await transcode(recorded.webm, join(directory, file))
    const texts = await Promise.all(
      recorded.texts.map(async ({ page, text }, index) => {
        const name = `${video.id}-${String(index + 1)}.txt`
        await writeFile(join(directory, name), text)
        return { file: name, sha256: sha256(text), page }
      })
    )
    return {
      file,
      sha256: sha256(await readFile(join(directory, file))),
      video: video.id,
      scheme: 'dark',
      build: 'rich',
      viewport: VIEWPORT,
      poster: video.poster,
      texts,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new CaptureError(`${video.id} (dark): ${reason}`)
  } finally {
    await rm(raw, { recursive: true, force: true })
  }
}
