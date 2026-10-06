// A shot as pages show it: its alt text, its size from its viewport, and its dark and light capture files.
export interface ISiteShot {
  alt: string
  width: number
  height: number
  dark: string
  light: string
}

export type SiteShots = Readonly<Record<string, ISiteShot>>

// A video as pages show it: its file, its size, and the capture shown before it plays.
export interface ISiteVideo {
  file: string
  width: number
  height: number
  poster: string
}

// What pages can show of the last capture: its shots, its videos, and the name of every file it wrote.
export interface ISiteCaptures {
  shots: SiteShots
  videos: Readonly<Record<string, ISiteVideo>>
  files: readonly string[]
}

// What the site reads of a shot of the shot list.
interface IListedShot {
  id: string
  alt: string
  viewport: readonly [number, number]
}

interface IShotEntry {
  file: string
  shot: string
  scheme: string
}

interface IVideoEntry {
  file: string
  video: string
  viewport: readonly [number, number]
  poster: string
}

type CaptureEntry = IShotEntry | IVideoEntry

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isShotEntry = (value: Record<string, unknown>): boolean =>
  typeof value.shot === 'string' && (value.scheme === 'dark' || value.scheme === 'light')

const isVideoEntry = (value: Record<string, unknown>): boolean =>
  typeof value.video === 'string' &&
  typeof value.poster === 'string' &&
  Array.isArray(value.viewport) &&
  value.viewport.length === 2 &&
  value.viewport.every((side) => typeof side === 'number')

const isCaptureEntry = (value: unknown): value is CaptureEntry =>
  isRecord(value) && typeof value.file === 'string' && (isShotEntry(value) || isVideoEntry(value))

const entriesOf = (manifest: unknown): CaptureEntry[] => {
  const captures = isRecord(manifest) ? manifest.captures : undefined
  if (!Array.isArray(captures) || !captures.every(isCaptureEntry)) {
    throw new Error(
      'The capture manifest holds no list of captures, each a shot with file and scheme or a video with file, viewport and poster'
    )
  }
  return captures
}

const fileOf = (entries: readonly IShotEntry[], shot: string, scheme: string): string | undefined =>
  entries.find((entry) => entry.shot === shot && entry.scheme === scheme)?.file

// Every shot of the list with both its captures in the manifest; a capture of a shot the list does not have is
// refused, naming it.
export const siteShotsOf = (manifest: unknown, shots: readonly IListedShot[]): SiteShots => {
  const entries = entriesOf(manifest).filter((entry) => 'shot' in entry)
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

// Every video of the manifest, and the name of every file the capture wrote.
export const siteVideosOf = (manifest: unknown): Pick<ISiteCaptures, 'videos' | 'files'> => {
  const entries = entriesOf(manifest)
  return {
    videos: Object.fromEntries(
      entries.flatMap((entry) =>
        'video' in entry
          ? [
              [
                entry.video,
                { file: entry.file, width: entry.viewport[0], height: entry.viewport[1], poster: entry.poster },
              ],
            ]
          : []
      )
    ),
    files: entries.map((entry) => entry.file),
  }
}

// One video by its id; a video or a poster the captures do not have stops the build, naming it and the page.
export const siteVideoOf = (captures: ISiteCaptures, id: string, page: string): ISiteVideo => {
  const video = captures.videos[id]
  if (video === undefined) {
    throw new Error(`${page} shows the video ${id}, which the captures do not have; run pnpm docs:capture`)
  }
  if (!captures.files.includes(video.poster)) {
    throw new Error(`${page} shows the video ${id}, whose poster ${video.poster} the captures do not have`)
  }
  return video
}

export type CaptureComponent = 'Shot' | 'Video'

// The id of every Shot or Video a page's HTML names, such as <Shot id="dashboard" />, so a build can refuse an unknown
// one before it renders the page.
export const idsIn = (html: string, component: CaptureComponent): string[] =>
  [...html.matchAll(new RegExp(`<${component}\\b[^>]*?\\bid="(?<id>[^"]*)"`, 'gu'))].map(
    (match) => match.groups?.id ?? ''
  )
