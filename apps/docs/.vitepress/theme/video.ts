import { useData, withBase } from 'vitepress'
import { defineComponent, h } from 'vue'
import { siteVideoOf } from '../../capture/captures.js'
import { data as captures } from './captures.data.js'

// A demo video, silent, behind its poster; preload="none", so a reader who does not press play downloads nothing. A
// video or poster the captures do not have stops the build, naming it and the page.
export const Video = defineComponent({
  props: { id: { type: String, required: true } },
  setup(props) {
    const { page } = useData()
    return () => {
      const video = siteVideoOf(captures, props.id, page.value.relativePath)
      return h('video', {
        class: 'video',
        src: withBase(`/captures/${video.file}`),
        poster: withBase(`/captures/${video.poster}`),
        width: video.width,
        height: video.height,
        controls: true,
        preload: 'none',
        playsinline: true,
        muted: true,
      })
    }
  },
})
