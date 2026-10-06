import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Where the published manifests' description and homepage come from, relative to the repository root.
export const README = 'README.md'
const SITE = 'apps/docs/site.ts'
// Each statement assigning SITE_URL, up to the end of its line.
const SITE_URL_ASSIGNMENT = /\bSITE_URL\s*=(?<value>[^\n]*)/gu
const STRING_LITERAL = /(?<quote>['"`])(?<text>.*?)\k<quote>/gu

// The CLI's description: the README's first line, the one sentence it opens with.
export const descriptionIn = (readme: string): string => {
  const [firstLine = ''] = readme.split('\n')
  const line = firstLine.trim()
  if (line === '' || line.startsWith('#')) {
    throw new Error(`${README} must open with the one sentence that describes Log Book, not "${line}".`)
  }
  return line
}

// Every package's homepage: the one https:// address apps/docs/site.ts assigns to SITE_URL, read as text so the stage
// imports nothing of the docs site.
export const homepageIn = (site: string): string => {
  const values = [...site.matchAll(SITE_URL_ASSIGNMENT)].flatMap(({ groups }) =>
    [...(groups?.value ?? '').matchAll(STRING_LITERAL)].map((literal) => literal.groups?.text ?? '')
  )
  const [value] = values
  if (values.length !== 1 || value === undefined || !value.startsWith('https://')) {
    const found = values.length === 0 ? 'none' : values.join(', ')
    throw new Error(`${SITE} must assign SITE_URL exactly one https:// address; it holds ${found}.`)
  }
  return value
}

export const descriptionOf = async (root: string): Promise<string> =>
  descriptionIn(await readFile(join(root, README), 'utf8'))

export const homepageOf = async (root: string): Promise<string> => homepageIn(await readFile(join(root, SITE), 'utf8'))
