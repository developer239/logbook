import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMANDS, EXIT_CODES, PACKAGE, parseCommandLine } from '@log-book/cli/grammar'
import { committedOf } from '../capture/captures.js'
import { checkK3 } from '../capture/k3.js'
import { checkK9 } from '../capture/k9.js'
import { SHOTS } from '../capture/shots.js'
import { BASE_PATH, SITE_URL } from '../site.js'
import { COMMITTED_CAPTURES } from './committed.js'
import { checkK1 } from './k1.js'
import { checkK2 } from './k2.js'
import { checkK4 } from './k4.js'
import { checkK5 } from './k5.js'
import { checkK6 } from './k6.js'
import { checkK7, findingLine } from './k7.js'
import { checkK8 } from './k8.js'
import { checkK10 } from './k10.js'
import { callSitesOf } from './privacy.js'
import { WHAT_TO_DO } from './what-to-do.js'

// The package's directory and the repository's, from dist/scripts where the build leaves this script.
const DOCS = fileURLToPath(new URL('../../', import.meta.url))
const REPOSITORY = fileURLToPath(new URL('../../../../', import.meta.url))
const BUILT = fileURLToPath(new URL('../../.vitepress/dist/', import.meta.url))
const CALL_SITES = join(REPOSITORY, 'packages', 'engine', 'network-call-sites.json')
const README = join(REPOSITORY, 'README.md')

// The site's own check on a finished build: one line per finding, and exit 1 when any rule fails.
const check = async (): Promise<number> => {
  if (!existsSync(join(BUILT, 'index.html'))) {
    process.stdout.write('There is no finished build of the site; run pnpm docs:build first.\n')
    return 1
  }
  const callSites = callSitesOf(await readFile(CALL_SITES, 'utf8'))
  const sizes = await checkK10({ built: BUILT, repository: REPOSITORY })
  for (const line of sizes.report) {
    process.stdout.write(`${line}\n`)
  }
  const committed = committedOf(JSON.parse(await readFile(join(DOCS, COMMITTED_CAPTURES), 'utf8')))
  const findings = [
    ...(await checkK1({ docs: DOCS, repository: REPOSITORY })),
    ...(await checkK2({ docs: DOCS, built: BUILT, repository: REPOSITORY })),
    ...(await checkK3({ captures: join(BUILT, 'captures'), repository: REPOSITORY })),
    ...(await checkK4({
      built: BUILT,
      readme: README,
      shotList: join(DOCS, 'capture', 'shots.ts'),
      repository: REPOSITORY,
      shots: SHOTS.map((shot) => shot.id),
    })),
    ...(await checkK5({
      readme: README,
      repository: REPOSITORY,
      siteUrl: SITE_URL,
      shots: SHOTS.map((shot) => shot.id),
      committed,
    })),
    ...(await checkK6({
      docs: DOCS,
      repository: REPOSITORY,
      callSites,
      built: BUILT,
      readme: README,
      siteUrl: SITE_URL,
    })),
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
    ...(await checkK8({ docs: DOCS, captures: join(BUILT, 'captures'), repository: REPOSITORY })),
    ...(await checkK9({ built: BUILT, basePath: BASE_PATH, repository: REPOSITORY })),
    ...sizes.findings,
  ]
  for (const finding of findings) {
    process.stdout.write(`${findingLine(finding)}\n`)
  }
  return findings.length > 0 ? 1 : 0
}

process.exitCode = await check()
