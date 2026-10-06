import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { COMMITTED_DIRECTORY } from '../capture/captures.js'
import { COMMITTED_CAPTURES, committedEntriesOf } from './committed.js'
import type { IFinding } from './k7.js'

export interface IK1Inputs {
  // The documentation package's directory, which holds the committed capture manifest and src.
  docs: string
  // Findings name files relative to it.
  repository: string
}

const RULE = 'K1'

// Committed captures live under src/public/committed/ and nowhere else: an entry naming a file elsewhere, and a file
// there that is no entry, both fail.
export const checkK1 = async ({ docs, repository }: IK1Inputs): Promise<IFinding[]> => {
  const manifest = join(docs, COMMITTED_CAPTURES)
  const manifestLines = (await readFile(manifest, 'utf8')).split('\n')
  const entries = await committedEntriesOf(docs)
  const directory = join(repository, COMMITTED_DIRECTORY)
  const present = existsSync(directory)
    ? (await readdir(directory, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => relative(repository, join(entry.parentPath, entry.name)))
    : []
  return [
    ...entries
      .filter(({ file }) => !file.startsWith(COMMITTED_DIRECTORY))
      .map(({ file }) => ({
        rule: RULE,
        file: relative(repository, manifest),
        line: Math.max(1, manifestLines.findIndex((line) => line.includes(`"${file}"`)) + 1),
        message: `${file} is outside ${COMMITTED_DIRECTORY}`,
      })),
    ...present
      .filter((file) => !entries.some((entry) => entry.file === file))
      .toSorted()
      .map((file) => ({
        rule: RULE,
        file,
        line: 1,
        message: `is not an entry of ${relative(repository, manifest)}`,
      })),
  ]
}
