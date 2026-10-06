import { readFile, writeFile } from 'node:fs/promises'
import { SITE_URL } from '../site.js'
import { syncedReadme } from './readme.js'

// From dist/scripts where the build leaves this script.
const README = new URL('../../../../README.md', import.meta.url)
const STATEMENT = new URL('../../src/privacy/statement.md', import.meta.url)

// Rewrites the README's statement block from statement.md, leaving the rest of the README as it is.
const [readme, statement] = await Promise.all([readFile(README, 'utf8'), readFile(STATEMENT, 'utf8')])
await writeFile(README, syncedReadme(readme, statement, SITE_URL))
