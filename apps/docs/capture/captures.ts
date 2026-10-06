// A shot as pages show it: its alt text, its size from its viewport, and its dark and light capture files.
export interface ISiteShot {
  alt: string
  width: number
  height: number
  dark: string
  light: string
}

export type SiteShots = Readonly<Record<string, ISiteShot>>

// What the site reads of a shot of the shot list.
interface IListedShot {
  id: string
  alt: string
  viewport: readonly [number, number]
}

interface ICaptureEntry {
  file: string
  shot: string
  scheme: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isCaptureEntry = (value: unknown): value is ICaptureEntry =>
  isRecord(value) &&
  typeof value.file === 'string' &&
  typeof value.shot === 'string' &&
  (value.scheme === 'dark' || value.scheme === 'light')

const entriesOf = (manifest: unknown): ICaptureEntry[] => {
  const captures = isRecord(manifest) ? manifest.captures : undefined
  if (!Array.isArray(captures) || !captures.every(isCaptureEntry)) {
    throw new Error('The capture manifest holds no list of captures with file, shot and scheme')
  }
  return captures
}

const fileOf = (entries: readonly ICaptureEntry[], shot: string, scheme: string): string | undefined =>
  entries.find((entry) => entry.shot === shot && entry.scheme === scheme)?.file

// Every shot of the list with both its captures in the manifest; a capture of a shot the list does not have is
// refused, naming it.
export const siteShotsOf = (manifest: unknown, shots: readonly IListedShot[]): SiteShots => {
  const entries = entriesOf(manifest)
  const unknown = entries.find((entry) => !shots.some((shot) => shot.id === entry.shot))
  if (unknown !== undefined) {
    throw new Error(`The capture manifest has the shot ${unknown.shot}, which the shot list does not have`)
  }
  return Object.fromEntries(
    shots.flatMap((shot) => {
      const [dark, light] = [fileOf(entries, shot.id, 'dark'), fileOf(entries, shot.id, 'light')]
      if (dark === undefined || light === undefined) {
        return []
      }
      const [width, height] = shot.viewport
      return [[shot.id, { alt: shot.alt, width, height, dark, light }]]
    })
  )
}

// One shot by its id; an id the captures do not have stops the build, naming it and the page.
export const siteShotOf = (shots: SiteShots, id: string, page: string): ISiteShot => {
  const shot = shots[id]
  if (shot === undefined) {
    throw new Error(`${page} shows the shot ${id}, which the captures do not have; run pnpm docs:capture`)
  }
  return shot
}

// A Shot of a page's HTML, such as <Shot id="dashboard" />.
const SHOT_TAG = /<Shot\b[^>]*?\bid="(?<id>[^"]*)"/gu

// The id of every Shot a page's HTML names, so a build can refuse an unknown one before it renders the page.
export const shotIdsIn = (html: string): string[] => [...html.matchAll(SHOT_TAG)].map((match) => match.groups?.id ?? '')
