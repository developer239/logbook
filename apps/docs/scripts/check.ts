import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMANDS, EXIT_CODES, PACKAGE, parseCommandLine } from '@log-book/cli/grammar'
import { checkK6 } from './k6.js'
import { checkK7, findingLine } from './k7.js'
import { callSitesOf } from './privacy.js'
import { WHAT_TO_DO } from './what-to-do.js'

// The package's directory and the repository's, from dist/scripts where the build leaves this script.
const DOCS = fileURLToPath(new URL('../../', import.meta.url))
const REPOSITORY = fileURLToPath(new URL('../../../../', import.meta.url))
const BUILT = fileURLToPath(new URL('../../.vitepress/dist/', import.meta.url))
const CALL_SITES = join(REPOSITORY, 'packages', 'engine', 'network-call-sites.json')

// The site's own check on a finished build: one line per finding, and exit 1 when any rule fails.
const check = async (): Promise<number> => {
  if (!existsSync(join(BUILT, 'index.html'))) {
    process.stdout.write('There is no finished build of the site; run pnpm docs:build first.\n')
    return 1
  }
  const callSites = callSitesOf(await readFile(CALL_SITES, 'utf8'))
  const findings = [
    ...(await checkK6({ docs: DOCS, repository: REPOSITORY, callSites, built: BUILT })),
    ...(await checkK7({
      docs: DOCS,
      repository: REPOSITORY,
      commands: COMMANDS,
      exitCodes: EXIT_CODES,
      whatToDo: WHAT_TO_DO,
      parse: parseCommandLine,
      binary: PACKAGE.binary,
      packageName: PACKAGE.name,
    })),
  ]
  for (const finding of findings) {
    process.stdout.write(`${findingLine(finding)}\n`)
  }
  return findings.length > 0 ? 1 : 0
}

process.exitCode = await check()
