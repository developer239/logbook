import { useData } from 'vitepress'
import { defineComponent, h } from 'vue'
import { factOf, type ICliFacts } from '../../scripts/facts.js'
import type { IThemeConfig } from './theme-config.js'

const INSTALL_VARIANTS = ['global', 'npx', 'next'] as const
type InstallVariant = (typeof INSTALL_VARIANTS)[number]

const isInstallVariant = (variant: string): variant is InstallVariant =>
  INSTALL_VARIANTS.some((candidate) => candidate === variant)

// The global install puts the binary on the PATH; npx runs the latest release, or the one its next dist-tag names.
const INSTALL_LINES: Readonly<Record<InstallVariant, (cli: ICliFacts['package']) => string[]>> = {
  global: ({ name, binary }) => [`npm install -g ${name}`, binary],
  npx: ({ name }) => [`npx ${name}`],
  next: ({ name, distTags: [, next] }) => [`npx ${name}@${next}`],
}

// One value of the CLI inline, such as the default port; an unknown name stops the build, naming it and the page.
export const Fact = defineComponent({
  props: { name: { type: String, required: true } },
  setup(props) {
    const { theme, page } = useData<IThemeConfig>()
    return () => h('span', factOf(theme.value.cli.facts, props.name, page.value.relativePath))
  },
})

// How to install and run Log Book: globally (the default), once through npx, or the next release through npx.
export const InstallCommand = defineComponent({
  props: { variant: { type: String, default: 'global' } },
  setup(props) {
    const { theme, page } = useData<IThemeConfig>()
    return () => {
      if (!isInstallVariant(props.variant)) {
        throw new Error(
          `${page.value.relativePath} asks for the install variant ${props.variant} (there are ${INSTALL_VARIANTS.join(', ')})`
        )
      }
      return h('div', { class: 'language-sh' }, [
        h('pre', [h('code', INSTALL_LINES[props.variant](theme.value.cli.package).join('\n'))]),
      ])
    }
  },
})
