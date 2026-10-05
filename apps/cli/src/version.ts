import { readFile } from 'node:fs/promises'

// This Log Book's version, read from its package.json at run time: the source and the built entry sit one directory
// below it alike.
export const readOwnVersion = async (): Promise<string> => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
  return manifest.version
}
