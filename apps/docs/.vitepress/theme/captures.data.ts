import { defineLoader } from 'vitepress'
import type { ISiteCaptures } from '../../capture/captures.js'
import { CAPTURE_MANIFEST, loadSiteCaptures } from '../../capture/site-captures.js'

declare const data: ISiteCaptures
export { data }

// The shots the Shot component and the videos the Video component show, from the last capture.
export default defineLoader({
  watch: [CAPTURE_MANIFEST],
  load: loadSiteCaptures,
})
