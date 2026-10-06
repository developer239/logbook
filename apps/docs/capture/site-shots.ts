import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { siteShotsOf, type SiteShots } from './captures.js'
import { SHOTS } from './shots.js'

// The run manifest pnpm docs:capture writes next to the captures.
const MANIFEST = fileURLToPath(new URL('../src/public/captures/manifest.json', import.meta.url))

export const CAPTURE_MANIFEST = MANIFEST

// The shots pages can show, from the last capture. Before any capture there are none, so a page that shows one stops
// the build, naming pnpm docs:capture, while the others still build.
export const loadSiteShots = async (): Promise<SiteShots> =>
  existsSync(MANIFEST) ? siteShotsOf(JSON.parse(await readFile(MANIFEST, 'utf8')), SHOTS) : {}
