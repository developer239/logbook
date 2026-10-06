import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { COMMANDS, EXIT_CODES, PACKAGE, parseCommandLine } from '@log-book/cli/grammar'
import { checkK7, findingLine } from './k7.js'
import { WHAT_TO_DO } from './what-to-do.js'

// The package's directory and the repository's, from dist/scripts where the build leaves this script.
const DOCS = fileURLToPath(new URL('../../', import.meta.url))
const REPOSITORY = fileURLToPath(new URL('../../../../', import.meta.url))
const BUILT_SITE = fileURLToPath(new URL('../../.vitepress/dist/index.html', import.meta.url))

// The site's own check on a finished build: one line per finding, and exit 1 when any rule fails.
const check = async (): Promise<number> => {
  if (!existsSync(BUILT_SITE)) {
    process.stdout.write('There is no finished build of the site; run pnpm docs:build first.\n')
    return 1
  }
  const findings = await checkK7({
    docs: DOCS,
    repository: REPOSITORY,
    commands: COMMANDS,
    exitCodes: EXIT_CODES,
    whatToDo: WHAT_TO_DO,
    parse: parseCommandLine,
    binary: PACKAGE.binary,
    packageName: PACKAGE.name,
  })
  for (const finding of findings) {
    process.stdout.write(`${findingLine(finding)}\n`)
  }
  return findings.length > 0 ? 1 : 0
}

process.exitCode = await check()
