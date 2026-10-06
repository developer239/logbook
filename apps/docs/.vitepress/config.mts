import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { type DefaultTheme, defineConfigWithTheme, type MarkdownEnv, type MarkdownRenderer } from 'vitepress'
import { attributesIn, type ISiteCaptures, siteCommittedOf, siteShotOf, siteVideoOf } from '../capture/captures.js'
import { loadSiteCaptures } from '../capture/site-captures.js'
import { cliFacts } from '../scripts/cli.js'
import { firstLineOf } from '../scripts/readme.js'
import { BASE_PATH, SITE_URL } from '../site.js'
import { versionAt } from '../version.js'
import type { IThemeConfig } from './theme/theme-config.js'

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
  {
    text: 'Getting started',
    items: [
      { text: 'Install', link: '/start/install' },
      { text: 'The first run', link: '/start/first-run' },
      { text: 'Update, disk space and uninstall', link: '/start/update' },
      { text: 'Try the next version', link: '/start/next' },
    ],
  },
  {
    text: 'Using Log Book',
    items: [
      { text: 'Dashboard', link: '/ui/dashboard' },
      { text: 'Conversations', link: '/ui/conversations' },
      { text: 'A conversation', link: '/ui/conversation' },
      { text: 'Steps', link: '/ui/steps' },
      { text: 'Tokens by tool', link: '/ui/tokens' },
      { text: 'Syncing and empty states', link: '/ui/states' },
    ],
  },
  {
    text: 'Labelling',
    items: [
      { text: 'How labelling works', link: '/labelling/' },
      { text: 'What it sends', link: '/labelling/what-it-sends' },
    ],
  },
  { text: 'Privacy', items: [{ text: 'What Log Book sends, and where', link: '/privacy/' }] },
  {
    text: 'Reference',
    items: [
      { text: 'The logbook command', link: '/reference/cli' },
      { text: 'Exit codes', link: '/reference/exit-codes' },
      { text: 'Environment variables', link: '/reference/environment' },
    ],
  },
  { text: 'Help', items: [{ text: 'Troubleshooting', link: '/help/troubleshooting' }] },
]

// The README's first line, so the site, the README and npm describe Log Book in the same sentence.
const description = firstLineOf(await readFile(new URL('../../../README.md', import.meta.url), 'utf8'))

// Every Shot and Video a page names is one the last capture made, with its poster, or a committed capture the committed
// capture manifest lists, checked while the page's Markdown renders, so an unknown one stops the build, naming it and
// the page.
const checkCaptures =
  (captures: ISiteCaptures) =>
  (md: MarkdownRenderer): void => {
    md.core.ruler.push('capture-ids', (state) => {
      const page = (state.env as MarkdownEnv).relativePath
      for (const token of state.tokens.flatMap((each) => [each, ...(each.children ?? [])])) {
        if (token.type === 'html_block' || token.type === 'html_inline') {
          for (const id of attributesIn(token.content, 'Shot', 'id')) {
            siteShotOf(captures.shots, id, page)
          }
          for (const file of attributesIn(token.content, 'Shot', 'committed')) {
            siteCommittedOf(captures, file, page)
          }
          for (const id of attributesIn(token.content, 'Video', 'id')) {
            siteVideoOf(captures, id, page)
          }
        }
      }
    })
  }

// The site describes the release it was built from, so a page never documents a flag the published CLI lacks.
const version = await versionAt(fileURLToPath(new URL('.', import.meta.url)))

export default defineConfigWithTheme<IThemeConfig>({
  title: 'Log Book',
  description,
  srcDir: 'src',
  markdown: { config: checkCaptures(await loadSiteCaptures()) },
  // Written parts that pages include, not pages of their own.
  srcExclude: ['reference/examples/**', 'privacy/statement.md', 'privacy/summary.md'],
  base: BASE_PATH,
  cleanUrls: true,
  appearance: 'dark',
  // The deploy builds a shallow checkout of a tag, so the dates would be wrong or missing.
  lastUpdated: false,
  sitemap: { hostname: SITE_URL },
  head: [
    ['meta', { 'http-equiv': 'Content-Security-Policy', 'content': CONTENT_SECURITY_POLICY }],
    ['meta', { property: 'og:image', content: new URL('captures/dashboard-dark.png', SITE_URL).href }],
  ],
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
    cli: await cliFacts(),
  },
})
