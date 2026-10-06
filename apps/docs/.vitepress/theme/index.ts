import { type Theme, useData } from 'vitepress'
import { createMermaidRenderer } from 'vitepress-mermaid-renderer'
import DefaultTheme from 'vitepress/theme'
import { defineComponent, h, onMounted, watch } from 'vue'
import { Fact, InstallCommand } from './components.js'
import { Shot } from './shot.js'
import './shot.css'

// Mermaid draws its diagrams in the scheme the reader has, dark or light.
const startMermaid = (isDark: boolean): void => {
  createMermaidRenderer({ theme: isDark ? 'dark' : 'default' })
}

export default {
  extends: DefaultTheme,
  // The default layout, with Mermaid started in the browser and started again when the reader switches the scheme.
  Layout: defineComponent({
    setup(_props, { slots }) {
      const { isDark } = useData()
      onMounted(() => {
        startMermaid(isDark.value)
      })
      watch(isDark, startMermaid)
      return () => h(DefaultTheme.Layout, null, slots)
    },
  }),
  enhanceApp({ app }) {
    app.component('Fact', Fact)
    app.component('InstallCommand', InstallCommand)
    app.component('Shot', Shot)
  },
} satisfies Theme
