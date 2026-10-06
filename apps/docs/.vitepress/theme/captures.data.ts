import { defineLoader } from 'vitepress'
import type { SiteShots } from '../../capture/captures.js'
import { CAPTURE_MANIFEST, loadSiteShots } from '../../capture/site-shots.js'

declare const data: SiteShots
export { data }

// The shots the Shot component shows, from the last capture.
export default defineLoader({
  watch: [CAPTURE_MANIFEST],
  load: loadSiteShots,
})
