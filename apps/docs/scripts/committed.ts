import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// An entry of the committed capture manifest, as the site's checks read it.
export interface ICommittedEntry {
  file: string
  sha256: string
}

// The two lists of committed images, relative to the documentation package.
const ARTWORK = 'artwork.json'
export const COMMITTED_CAPTURES = 'committed-captures.json'
// The extensions of the image and video files the checks cover, in any letter case.
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|svg|mp4|webm|mov)$/iu

export const isImage = (path: string): boolean => IMAGE_EXTENSION.test(path)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const listIn = async (docs: string, file: string, key: string): Promise<unknown[]> => {
  const parsed: unknown = JSON.parse(await readFile(join(docs, file), 'utf8'))
  const list = isRecord(parsed) ? parsed[key] : undefined
  if (!Array.isArray(list)) {
    throw new Error(`apps/docs/${file} holds no "${key}" list`)
  }
  return Array.from<unknown>(list)
}

// The artwork files, repository-relative.
export const artworkOf = async (docs: string): Promise<string[]> =>
  (await listIn(docs, ARTWORK, 'files')).filter((file) => typeof file === 'string')

// The committed capture manifest's entries with a file and a SHA-256; pnpm check:literals --owner checks the rest.
export const committedEntriesOf = async (docs: string): Promise<ICommittedEntry[]> =>
  (await listIn(docs, COMMITTED_CAPTURES, 'captures')).flatMap((entry) =>
    isRecord(entry) && typeof entry.file === 'string' && typeof entry.sha256 === 'string'
      ? [{ file: entry.file, sha256: entry.sha256 }]
      : []
  )

export const sha256Of = async (path: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
