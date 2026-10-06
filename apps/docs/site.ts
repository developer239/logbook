// The site's address, from which the site's base path, the README's links and every npm package's homepage derive.
// The release stage reads this file as text, never imports it, so it holds exactly one address.
export const SITE_URL = 'https://developer239.github.io/logbook/'

// The path the site is served under: its path on github.io, the root once the site has a domain of its own.
export const basePathOf = (url: string): string => {
  const { hostname, pathname } = new URL(url)
  return hostname.endsWith('.github.io') ? pathname : '/'
}

export const BASE_PATH = basePathOf(SITE_URL)
