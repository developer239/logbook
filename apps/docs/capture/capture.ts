import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserContext, Page } from 'playwright'
import { PANELS, pathOf, type DemoPlan, type IShot, type Scheme } from './shots.js'

export interface ICaptureRecord {
  file: string
  sha256: string
  shot: string
  scheme: Scheme
  build: string
  page: string
  range: string | null
  viewport: readonly [number, number]
  text: string
  textSha256: string
}

// A capture that cannot be trusted: the line names the shot and the reason.
class CaptureError extends Error {}

const CSP_VIOLATION = /Content Security Policy/u
// How long a page may take to show a shot's texts or its Turn pane.
const SETTLE_MS = 15_000

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

// What a page load did that a capture may not show: a request to another origin or a Content Security Policy
// violation, collected while the page loads.
const guarded = async (page: Page, origin: string): Promise<string[]> => {
  const problems: string[] = []
  await page.route('**/*', async (route) => {
    const url = route.request().url()
    if (new URL(url).origin === origin || url.startsWith('data:')) {
      await route.continue()
      return
    }
    problems.push(`a request to another origin: ${url}`)
    await route.abort()
  })
  page.on('console', (message) => {
    if (CSP_VIOLATION.test(message.text())) {
      problems.push(`a Content Security Policy violation: ${message.text()}`)
    }
  })
  return problems
}

// The state panels the page shows that the shot does not ask for.
const unwantedPanels = async (page: Page, shot: IShot): Promise<string[]> => {
  const panels = [PANELS.error, PANELS.firstRun, ...(shot.shows === 'not-labelled' ? [] : [PANELS.notLabelled])]
  const shown = await Promise.all(panels.map(async (panel) => (await page.locator(panel.selector).count()) > 0))
  return panels.filter((_panel, index) => shown[index] === true).map((panel) => `the page shows ${panel.name}`)
}

const waitForTexts = async (page: Page, shot: IShot, settleMs: number): Promise<void> => {
  await Promise.all(
    shot.expect.map(async (text) => {
      try {
        await page.getByText(text).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: settleMs })
      } catch {
        throw new CaptureError(`the page does not show "${text}"`)
      }
    })
  )
}

// Scrolls the conversation until the turn is under the reading line, 30% down below the session map, and waits until
// the Turn pane shows it.
const scrollToTurn = async (page: Page, turn: number, settleMs: number): Promise<void> => {
  const turnId = await page.evaluate((number) => {
    const turns = [...document.querySelectorAll<HTMLElement>('[data-thread] > [data-turn]')]
    const target = turns[number - 1]
    if (target === undefined) {
      return null
    }
    const mapHeight = document.querySelector('[data-map]')?.getBoundingClientRect().height ?? 0
    const line = mapHeight + (window.innerHeight - mapHeight) * 0.3
    // The line in the middle of the turn, so a few pixels the page measured differently cannot pick its neighbour.
    const box = target.getBoundingClientRect()
    window.scrollTo(0, box.top + box.height / 2 + window.scrollY - line)
    return target.dataset.turn ?? null
  }, turn)
  if (turnId === null) {
    throw new CaptureError(`the conversation has no turn ${String(turn)}`)
  }
  await page.locator(`[data-turn-pane="${turnId}"]`).waitFor({ state: 'visible', timeout: settleMs })
}

// The page's visible text, then every link and source target on it, one per line, ending with a newline.
const textOf = async (page: Page): Promise<string> =>
  page.evaluate(() => {
    const targets = [...document.querySelectorAll('[href], [src]')].flatMap((element) =>
      ['href', 'src'].flatMap((name) => element.getAttribute(name) ?? [])
    )
    return `${[document.body.innerText, ...targets].join('\n')}\n`
  })

const openShot = async (page: Page, host: string, shot: IShot, plan: DemoPlan): Promise<string> => {
  const path = pathOf(shot.page, shot.range, plan)
  await page.goto(new URL(path, host).href, { waitUntil: 'networkidle' })
  if (shot.page.kind !== 'follow') {
    return path
  }
  const href = await page.locator(shot.page.link).first().getAttribute('href')
  if (href === null) {
    throw new CaptureError(`${path} has no link ${shot.page.link}`)
  }
  await page.goto(new URL(href, host).href, { waitUntil: 'networkidle' })
  return href
}

export interface ICaptureInputs {
  context: BrowserContext
  host: string
  plan: DemoPlan
  shot: IShot
  scheme: Scheme
  directory: string
  // How long to wait for the page; 15 seconds when absent.
  settleMs?: number
}

// One shot in one scheme: the PNG and the text capture of the same page load, written into the directory, or a
// CaptureError naming the shot and why.
export const captureShot = async ({
  context,
  host,
  plan,
  shot,
  scheme,
  directory,
  settleMs = SETTLE_MS,
}: ICaptureInputs): Promise<ICaptureRecord> => {
  const page = await context.newPage()
  try {
    await page.setViewportSize({ width: shot.viewport[0], height: shot.viewport[1] })
    const problems = await guarded(page, new URL(host).origin)
    const opened = await openShot(page, host, shot, plan)
    if (shot.turn !== null) {
      await scrollToTurn(page, shot.turn, settleMs)
    }
    await waitForTexts(page, shot, settleMs)
    const found = [...problems, ...(await unwantedPanels(page, shot))]
    if (found.length > 0) {
      throw new CaptureError(found.join('; '))
    }
    const png = await (shot.selector === null ? page.screenshot() : page.locator(shot.selector).first().screenshot())
    const text = await textOf(page)
    const name = `${shot.id}-${scheme}`
    await Promise.all([writeFile(join(directory, `${name}.png`), png), writeFile(join(directory, `${name}.txt`), text)])
    return {
      file: `${name}.png`,
      sha256: sha256(png),
      shot: shot.id,
      scheme,
      build: shot.build,
      page: opened,
      range: shot.range?.label ?? null,
      viewport: shot.viewport,
      text: `${name}.txt`,
      textSha256: sha256(text),
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new CaptureError(`${shot.id} (${scheme}): ${reason}`)
  } finally {
    await page.close()
  }
}
