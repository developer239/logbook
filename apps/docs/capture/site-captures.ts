import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { committedOf, siteShotsOf, siteVideosOf, type ISiteCaptures } from './captures.js'
import { SHOTS } from './shots.js'

// The run manifest pnpm docs:capture writes next to the captures.
const MANIFEST = fileURLToPath(new URL('../src/public/captures/manifest.json', import.meta.url))

export const CAPTURE_MANIFEST = MANIFEST
// The committed capture manifest, which lists the captures committed under src/public/committed.
export const COMMITTED_MANIFEST = fileURLToPath(new URL('../committed-captures.json', import.meta.url))

// The shots and videos pages can show, from the last capture, and the committed captures. Before any capture there are
// no shots or videos, so a page that shows one stops the build, naming pnpm docs:capture, while the others still build.
export const loadSiteCaptures = async (): Promise<ISiteCaptures> => {
  const committed = committedOf(JSON.parse(await readFile(COMMITTED_MANIFEST, 'utf8')))
  if (!existsSync(MANIFEST)) {
    return { shots: {}, videos: {}, files: [], committed }
  }
  const manifest: unknown = JSON.parse(await readFile(MANIFEST, 'utf8'))
  return { shots: siteShotsOf(manifest, SHOTS), ...siteVideosOf(manifest), committed }
}
