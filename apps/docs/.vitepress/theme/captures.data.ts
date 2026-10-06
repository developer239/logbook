import { defineLoader } from 'vitepress'
import type { ISiteCaptures } from '../../capture/captures.js'
import { CAPTURE_MANIFEST, COMMITTED_MANIFEST, loadSiteCaptures } from '../../capture/site-captures.js'

declare const data: ISiteCaptures
export { data }

// The shots and committed captures the Shot component and the videos the Video component show.
export default defineLoader({
  watch: [CAPTURE_MANIFEST, COMMITTED_MANIFEST],
  load: loadSiteCaptures,
})
