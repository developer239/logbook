import { cp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { build, stop, type BuildResult, type Plugin } from 'esbuild'
import { harnessIdsIn } from '../checks/literals.js'
import { descriptionOf, homepageOf, README } from './published-fields.js'
import { writeThirdParty } from './third-party.js'

// Where the stage reads and writes, relative to the repository root. It reads the workspace's builds as files and
// imports no workspace package.
const PACKAGE = 'apps/cli/package'
const CLI_MANIFEST = 'apps/cli/package.json'
const CLI_ENTRY = 'apps/cli/dist/cli.mjs'
const SHIM = 'apps/cli/bin/logbook.cjs'
const METAFILE = 'apps/cli/build/metafile.json'
// The CLI's module naming the web app's build; the bundle gets one naming dist/web/ beside itself.
const WEB_BUILD_MODULE = 'apps/cli/dist/web-build.js'
// The engine forks its rewrite process from rewrite-process.<extension> beside its own module, which in the bundle
// is dist/cli.mjs.
const REWRITE_ENTRY = 'packages/engine/dist/rewrite/rewrite-process.js'
const PROMPTS = 'packages/engine/dist/prompts'
const WEB_DIST = 'apps/web/dist'
const LICENSE = 'LICENSE.md'

const BUNDLED_WEB_BUILD = "export const WEB_BUILD = new URL('./web/', import.meta.url)\n"

interface IWorkspaceManifest {
  bin: Record<string, string>
  engines: Record<string, string>
  os: string[]
}

// What npm shows of the package: the README's opening sentence in search, and the site as its homepage.
interface IPublishedFields {
  description: string
  homepage: string
}

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === 'string')

// The fields the published manifest takes from the workspace's, checked here so a missing one fails the stage.
const workspaceManifestOf = (text: string): IWorkspaceManifest => {
  const { bin, engines, os } = JSON.parse(text) as Record<string, unknown>
  if (!isStringRecord(bin) || !isStringRecord(engines) || !Array.isArray(os)) {
    throw new Error(`${CLI_MANIFEST} needs bin and engines as objects of strings and os as a list.`)
  }
  return { bin, engines, os: os.map(String) }
}

// The published manifest, exactly these fields, its keywords led by the harness ids the adapters bring. No dependency
// field and no scripts: nothing is installed beside the bundle and no install-time code runs. The publish job writes
// the release version.
export const cliManifest = (
  workspace: IWorkspaceManifest,
  harnessIds: readonly string[],
  published: IPublishedFields
): Record<string, unknown> => ({
  name: '@log-book/cli',
  description: published.description,
  version: '0.0.0-development',
  license: 'PolyForm-Noncommercial-1.0.0',
  type: 'module',
  bin: workspace.bin,
  engines: workspace.engines,
  os: workspace.os,
  files: ['bin/', 'dist/', 'THIRD-PARTY-NOTICES.md'],
  homepage: published.homepage,
  repository: { type: 'git', url: 'git+https://github.com/developer239/logbook.git', directory: 'apps/cli' },
  bugs: 'https://github.com/developer239/logbook/issues',
  keywords: [...harnessIds, 'coding-agent', 'transcripts', 'analytics', 'local-first'],
  publishConfig: { access: 'public' },
})

// The manifest the stage writes for the CLI, from the workspace's manifest, the adapters and the published fields.
export const cliManifestOf = async (root: string): Promise<Record<string, unknown>> => {
  const workspace = workspaceManifestOf(await readFile(join(root, CLI_MANIFEST), 'utf8'))
  const harnessIds = harnessIdsIn((await readdir(join(root, 'packages'))).map((name) => `packages/${name}/`))
  return cliManifest(workspace, harnessIds, {
    description: await descriptionOf(root),
    homepage: await homepageOf(root),
  })
}

// Replaces the CLI's web build module in the bundle, and records that it did.
const webBuildModule = (path: string, replaced: { isDone: boolean }): Plugin => ({
  name: 'web-build',
  setup: (bundle) => {
    // esbuild runs its filters as Go regular expressions, which take no `u` flag.
    bundle.onLoad({ filter: /web-build\.js$/ }, (args) => {
      if (args.path !== path) {
        return undefined
      }
      replaced.isDone = true
      return { contents: BUNDLED_WEB_BUILD, loader: 'js' }
    })
  },
})

// `pnpm stage`: writes apps/cli/package/, the directory npm packs as @log-book/cli, from the workspace's builds. It
// empties the directory first, so nothing of an earlier stage survives.
export const stageCli = async (givenRoot: string): Promise<void> => {
  const root = await realpath(givenRoot)
  const at = (path: string): string => join(root, path)
  const manifest = await cliManifestOf(root)

  await rm(at(PACKAGE), { recursive: true, force: true })
  await mkdir(dirname(at(METAFILE)), { recursive: true })

  // Unminified and without source maps: the published code stays searchable, and maps would double its size.
  const replaced = { isDone: false }
  let result: BuildResult<{ metafile: true }>
  try {
    result = await build({
      absWorkingDir: root,
      entryPoints: [
        { in: CLI_ENTRY, out: 'cli' },
        { in: REWRITE_ENTRY, out: 'rewrite-process' },
      ],
      outdir: at(join(PACKAGE, 'dist')),
      outExtension: { '.js': '.mjs' },
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node24',
      minify: false,
      sourcemap: false,
      metafile: true,
      logLevel: 'silent',
      plugins: [webBuildModule(at(WEB_BUILD_MODULE), replaced)],
    })
  } finally {
    // esbuild keeps a service process for the next build; there is none.
    await stop()
  }
  if (!replaced.isDone) {
    throw new Error(`The CLI's bundle did not include ${WEB_BUILD_MODULE}, so it would not find the web app's build.`)
  }
  await writeFile(at(METAFILE), JSON.stringify(result.metafile))

  // The web app's build is copied, not inlined: Astro's server output finds its client files from its own location.
  await Promise.all([
    cp(at(join(WEB_DIST, 'server')), at(join(PACKAGE, 'dist/web/server')), { recursive: true }),
    cp(at(join(WEB_DIST, 'client')), at(join(PACKAGE, 'dist/web/client')), { recursive: true }),
    cp(at(join(WEB_DIST, 'guard.js')), at(join(PACKAGE, 'dist/web/guard.js'))),
    cp(at(PROMPTS), at(join(PACKAGE, 'dist/prompts')), { recursive: true }),
    cp(at(SHIM), at(join(PACKAGE, 'bin/logbook.cjs'))),
    cp(at(LICENSE), at(join(PACKAGE, 'LICENSE.md'))),
    // The root README is the CLI's npm page; its images link to the site, so the package carries none.
    cp(at(README), at(join(PACKAGE, README))),
  ])
  await writeFile(at(join(PACKAGE, 'package.json')), `${JSON.stringify(manifest, null, 2)}\n`)
  // The licence notices of the npm code the bundle and the copied web build carry.
  await writeThirdParty(root)
}
