import { fileURLToPath } from 'node:url'
import { build } from 'vitepress'
import { generate } from '../scripts/generate.js'
import { runCapture } from './main.js'

// The package's directory, from dist/capture where the build leaves this module.
const DOCS = fileURLToPath(new URL('../../', import.meta.url))

// pnpm docs:build: generates the reference parts, captures the demo shots (--demo-out passes through), then builds
// the site, so every page shows the product as it is now.
export const buildSite = async (argv: readonly string[], write: (line: string) => void): Promise<number> => {
  await generate()
  const captured = await runCapture(argv, write)
  if (captured !== 0) {
    return captured
  }
  await build(DOCS)
  return 0
}
