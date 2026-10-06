import { readFile } from 'node:fs/promises'
import { COMMANDS, PACKAGE } from '@log-book/cli/grammar'
import { factsOf, type ICliFacts } from './facts.js'

// The CLI's manifest, read as a file for its Node floor: the CLI exports only its command table.
const CLI_MANIFEST = new URL('../../cli/package.json', import.meta.url)

const enginesOf = (manifest: unknown): string => {
  if (
    typeof manifest === 'object' &&
    manifest !== null &&
    'engines' in manifest &&
    typeof manifest.engines === 'object' &&
    manifest.engines !== null &&
    'node' in manifest.engines &&
    typeof manifest.engines.node === 'string'
  ) {
    return manifest.engines.node
  }
  throw new Error('The CLI manifest has no engines.node')
}

// The package, binary and dist-tags, and the facts the pages name, from the CLI's command table and manifest.
export const cliFacts = async (): Promise<ICliFacts> => {
  const manifest: unknown = JSON.parse(await readFile(CLI_MANIFEST, 'utf8'))
  return { package: PACKAGE, facts: factsOf(COMMANDS, enginesOf(manifest)) }
}
