import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { COMMITTED_DIRECTORY } from '../capture/captures.js'
import { artworkOf, committedEntriesOf, isImage, sha256Of } from './committed.js'
import type { IFinding } from './k7.js'

export interface IK2Inputs {
  // The documentation package's directory, which holds the two lists.
  docs: string
  // The built site, such as .vitepress/dist.
  built: string
  // Findings name files relative to it.
  repository: string
}

const RULE = 'K2'
const PUBLIC = 'apps/docs/src/public/'
const CAPTURES = 'captures/'
const COMMITTED = 'committed/'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

// The files this build's capture manifest records, by their path in the built site, with their SHA-256.
const manifestFiles = async (built: string): Promise<Map<string, unknown>> => {
  const manifest: unknown = JSON.parse(await readFile(join(built, CAPTURES, 'manifest.json'), 'utf8'))
  const captures = isRecord(manifest) && Array.isArray(manifest.captures) ? manifest.captures : []
  return new Map(
    captures.flatMap((capture) =>
      isRecord(capture) && typeof capture.file === 'string' ? [[`${CAPTURES}${capture.file}`, capture.sha256]] : []
    )
  )
}

// Every image or video of the built site has a source on record: artwork at its place in the site, a file of this
// build's capture manifest with an equal SHA-256, or a committed capture whose entry has an equal SHA-256.
export const checkK2 = async ({ docs, built, repository }: IK2Inputs): Promise<IFinding[]> => {
  const artwork = new Set(
    (await artworkOf(docs)).filter((file) => file.startsWith(PUBLIC)).map((file) => file.slice(PUBLIC.length))
  )
  const captures = await manifestFiles(built)
  const committed = new Map(
    (await committedEntriesOf(docs))
      .filter(({ file }) => file.startsWith(COMMITTED_DIRECTORY))
      .map(({ file, sha256 }) => [`${COMMITTED}${file.slice(COMMITTED_DIRECTORY.length)}`, sha256])
  )
  const images = (await readdir(built, { recursive: true }))
    .map((path) => path.split(sep).join('/'))
    .filter(isImage)
    .toSorted()
  const findings = await Promise.all(
    images.map(async (path): Promise<IFinding[]> => {
      if (artwork.has(path)) {
        return []
      }
      const recorded = captures.get(path) ?? committed.get(path)
      const at = { rule: RULE, file: relative(repository, join(built, path)), line: 1 }
      if (recorded === undefined) {
        return [{ ...at, message: "is not artwork, a capture of this build's manifest or a committed capture" }]
      }
      return recorded === (await sha256Of(join(built, path)))
        ? []
        : [{ ...at, message: 'differs from the SHA-256 its source on record holds' }]
    })
  )
  return findings.flat()
}
