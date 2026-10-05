import node from '@astrojs/node'
import { defineConfig, passthroughImageService } from 'astro/config'
import { guardDevServer } from './src/lib/dev-guard.ts'

export default defineConfig({
  output: 'server',
  // Middleware mode binds no socket: the logbook host mounts the handler on its own server on 127.0.0.1, so no
  // variable such as HOST can move the address.
  adapter: node({ mode: 'middleware' }),
  // Astro's default, written out so it cannot be switched off unnoticed; a second layer behind the host's guard.
  security: { checkOrigin: true },
  // Vite's own Host check runs first and allows any IP address; the stricter guard of src/lib/dev-guard.ts answers in
  // its place.
  server: { host: '127.0.0.1', allowedHosts: true },
  devToolbar: { enabled: false },
  // The default service ships a sharp loader behind /_image that the CLI's tarball cannot hold; no page uses
  // astro:assets images.
  image: { service: passthroughImageService() },
  // The pages allow no inline script (script-src 'self'), so Astro must not inline a small processed script.
  vite: { build: { assetsInlineLimit: 0 }, plugins: [guardDevServer] },
})
