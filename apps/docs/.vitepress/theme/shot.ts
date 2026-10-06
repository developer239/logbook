import { useData, withBase } from 'vitepress'
import { defineComponent, h, type VNode } from 'vue'
import { siteCommittedOf, siteShotOf, type ISiteShot } from '../../capture/captures.js'
import { data as captures } from './captures.data.js'

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

const captionOf = (caption: string | undefined): VNode[] =>
  caption === undefined ? [] : [h('figcaption', { class: 'shot__caption' }, caption)]

// A demo capture by its id, in the reader's colour scheme, or a committed capture by its path under committed/, as it
// is, with its alt text; the caption goes under either when given. A capture the site does not have stops the build,
// naming it and the page.
export const Shot = defineComponent({
  props: {
    id: { type: String, required: false },
    committed: { type: String, required: false },
    alt: { type: String, required: false },
    caption: { type: String, required: false },
  },
  setup(props) {
    const { page } = useData()
    return () => {
      const where = page.value.relativePath
      if (props.committed !== undefined) {
        const file = siteCommittedOf(captures, props.committed, where)
        return h('figure', { class: 'shot' }, [
          h('img', {
            class: 'shot__image',
            src: withBase(`/committed/${file}`),
            alt: props.alt ?? '',
            loading: 'lazy',
          }),
          ...captionOf(props.caption),
        ])
      }
      if (props.id === undefined) {
        throw new Error(`${where} has a Shot with neither an id nor a committed capture`)
      }
      const shot = siteShotOf(captures.shots, props.id, where)
      return h('figure', { class: 'shot' }, [image(shot, 'dark'), image(shot, 'light'), ...captionOf(props.caption)])
    }
  },
})
