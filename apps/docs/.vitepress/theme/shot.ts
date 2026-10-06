import { useData, withBase } from 'vitepress'
import { defineComponent, h, type VNode } from 'vue'
import { siteShotOf, type ISiteShot } from '../../capture/captures.js'
import { data as shots } from './captures.data.js'

type Scheme = 'dark' | 'light'

// Both captures are in the page and the theme's dark class shows one, so the image follows the reader's scheme with
// no flash; a lazy image hidden by CSS is never fetched.
const image = (shot: ISiteShot, scheme: Scheme): VNode =>
  h('img', {
    class: `shot__image shot__image--${scheme}`,
    src: withBase(`/captures/${shot[scheme]}`),
    alt: shot.alt,
    width: shot.width,
    height: shot.height,
    loading: 'lazy',
  })

// A demo capture in the reader's colour scheme, with its caption under it when given; an id the captures do not have
// stops the build, naming it and the page.
export const Shot = defineComponent({
  props: {
    id: { type: String, required: true },
    caption: { type: String, required: false },
  },
  setup(props) {
    const { page } = useData()
    return () => {
      const shot = siteShotOf(shots, props.id, page.value.relativePath)
      return h('figure', { class: 'shot' }, [
        image(shot, 'dark'),
        image(shot, 'light'),
        ...(props.caption === undefined ? [] : [h('figcaption', { class: 'shot__caption' }, props.caption)]),
      ])
    }
  },
})
