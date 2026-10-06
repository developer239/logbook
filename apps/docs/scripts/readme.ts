const START = '<!-- statement:start -->'
const END = '<!-- statement:end -->'
// A Markdown link to a page of the site, such as (/privacy/).
const SITE_LINK = /\]\(\/(?<path>[^)\s]*)\)/gu
const HEADING = /^#{1,6}\s/u

// The statement as the README holds it: each site-relative link absolute against the site's address.
const readmeStatement = (statement: string, siteUrl: string): string =>
  statement.trim().replaceAll(SITE_LINK, (_match, path: string) => `](${new URL(path, siteUrl).href})`)

const markersOf = (readme: string): { start: number; end: number } | null => {
  const start = readme.indexOf(START)
  const end = readme.indexOf(END)
  return start === -1 || end === -1 || end < start ? null : { start, end }
}

// The README with the block between its markers rewritten from the statement, and every other line kept.
export const syncedReadme = (readme: string, statement: string, siteUrl: string): string => {
  const markers = markersOf(readme)
  if (markers === null) {
    throw new Error(`README.md needs ${START} and then ${END} around the statement`)
  }
  return `${readme.slice(0, markers.start + START.length)}\n\n${readmeStatement(statement, siteUrl)}\n\n${readme.slice(markers.end)}`
}

// Why the README's statement is not the site's, or null when it is.
export const readmeDrift = (readme: string, statement: string, siteUrl: string): string | null => {
  if (markersOf(readme) === null) {
    return `README.md lacks ${readme.includes(START) ? END : START} around the statement`
  }
  return syncedReadme(readme, statement, siteUrl) === readme
    ? null
    : "README.md's statement differs from statement.md; run pnpm docs:sync-readme"
}

// The README's first line: the sentence npm shows as the CLI's description, which the site's description repeats.
export const firstLineOf = (readme: string): string => {
  const [first = ''] = readme.split('\n')
  if (first.trim() === '' || HEADING.test(first)) {
    throw new Error('README.md must start with the one-sentence description, not an empty line or a heading')
  }
  return first
}
