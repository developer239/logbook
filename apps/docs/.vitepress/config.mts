import { fileURLToPath } from 'node:url'
import { type DefaultTheme, defineConfig } from 'vitepress'
import { BASE_PATH, SITE_URL } from '../site.js'
import { versionAt } from '../version.js'

const REPOSITORY = 'https://github.com/developer239/logbook'
// GitHub Pages sends no response headers, so the policy is a meta tag. The browser refuses every other origin: the
// site sets no cookie, runs no analytics and loads its fonts from its own bundle. 'unsafe-inline' covers the script
// VitePress runs to set the colour scheme before paint, and Mermaid's inline styles.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')
// In this order; each page's ticket adds its pages to its group, and a group with no page yet is left out.
const SIDEBAR: DefaultTheme.SidebarItem[] = [
  { text: 'Getting started', items: [] },
  { text: 'Using Log Book', items: [] },
  { text: 'Labelling', items: [] },
  { text: 'Privacy', items: [] },
  { text: 'Reference', items: [] },
  { text: 'Help', items: [] },
]

// The site describes the release it was built from, so a page never documents a flag the published CLI lacks.
const version = await versionAt(fileURLToPath(new URL('.', import.meta.url)))

export default defineConfig({
  title: 'Log Book',
  description: "Where your coding agent's time went.",
  srcDir: 'src',
  base: BASE_PATH,
  cleanUrls: true,
  appearance: 'dark',
  // The deploy builds a shallow checkout of a tag, so the dates would be wrong or missing.
  lastUpdated: false,
  sitemap: { hostname: SITE_URL },
  head: [['meta', { 'http-equiv': 'Content-Security-Policy', 'content': CONTENT_SECURITY_POLICY }]],
  themeConfig: {
    nav: [
      { text: 'Docs', link: '/start/install' },
      { text: 'Reference', link: '/reference/cli' },
      { text: 'Releases', link: `${REPOSITORY}/releases` },
      { text: version, link: version === 'main' ? `${REPOSITORY}/tree/main` : `${REPOSITORY}/releases/tag/${version}` },
      { text: 'GitHub', link: REPOSITORY },
    ],
    sidebar: SIDEBAR.filter((group) => (group.items?.length ?? 0) > 0),
    // The index ships with the site, so a query never leaves the page.
    search: { provider: 'local' },
    editLink: { pattern: `${REPOSITORY}/edit/main/apps/docs/src/:path` },
    footer: { message: 'Source-available under the PolyForm Noncommercial License 1.0.0.' },
  },
})
