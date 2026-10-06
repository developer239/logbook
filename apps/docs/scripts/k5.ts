import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import type { IFinding } from './k7.js'

export interface IK5Inputs {
  // The repository's README.
  readme: string
  // Findings name files relative to it.
  repository: string
  siteUrl: string
  // The ids of the shot list.
  shots: readonly string[]
  // The committed captures, by their path under committed/.
  committed: readonly string[]
}

const RULE = 'K5'
const SCHEMES = ['dark', 'light']
// Badges: images that show a status or a fact about the project, never a capture.
const BADGE_PREFIXES = ['https://img.shields.io/', 'https://github.com/developer239/logbook/actions/workflows/']
// A Markdown image's address, or an img element's.
const IMAGE = /!\[[^\]]*\]\((?<markdown>[^)\s]+)[^)]*\)|<img\b[^>]*?\bsrc="(?<html>[^"]+)"/gu

// The README shows only shots' captures and committed captures, at the site's address, so a capture the site does not
// publish cannot appear in it; besides them, only badges.
export const checkK5 = async ({ readme, repository, siteUrl, shots, committed }: IK5Inputs): Promise<IFinding[]> => {
  const allowed = new Set([
    ...shots.flatMap((id) => SCHEMES.map((scheme) => `${siteUrl}captures/${id}-${scheme}.png`)),
    ...committed.map((file) => `${siteUrl}committed/${file}`),
  ])
  return (await readFile(readme, 'utf8')).split('\n').flatMap((line, index) =>
    [...line.matchAll(IMAGE)]
      .map((match) => match.groups?.markdown ?? match.groups?.html ?? '')
      .filter((url) => !allowed.has(url) && !BADGE_PREFIXES.some((prefix) => url.startsWith(prefix)))
      .map((url) => ({
        rule: RULE,
        file: relative(repository, readme),
        line: index + 1,
        message: `the image ${url} is neither a shot's capture, a committed capture nor a badge`,
      }))
  )
}
