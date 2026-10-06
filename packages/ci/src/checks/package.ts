import { execFile } from 'node:child_process'
import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { homepageOf } from '../stage/published-fields.js'
import { cliManifestOf } from '../stage/stage-cli.js'
import {
  type IPublicPackage,
  libraryStageOf,
  ownImportsOf,
  PUBLIC_PACKAGES,
  publicPackagesIn,
  PUBLISH_ORDER,
  STAGED,
} from '../stage/stage-libraries.js'
import { contentRuleFindings, type IStagedPackage } from './package-content.js'

const run = promisify(execFile)
const MAX_LISTING_BYTES = 64 * 1024 * 1024
const VERSION = '0.0.0-development'
const OWN_SCOPE = '@log-book/'
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundleDependencies',
  'bundledDependencies',
]
// The fields of each table that have rules of their own, so the field comparison leaves them out.
const CLI_OWN_RULES = [...DEPENDENCY_FIELDS, 'exports']
const LIBRARY_OWN_RULES = ['exports', 'dependencies']

// The files each kind of package may hold. The CLI's rewrite process is the bundle stage-cli writes beside cli.mjs; a
// library also holds the JSON modules its code imports and the assets the public package list names for it.
const CLI_LAYOUT = [
  /^package\.json$/u,
  /^README\.md$/u,
  /^LICENSE\.md$/u,
  /^THIRD-PARTY-NOTICES\.md$/u,
  /^bin\/logbook\.cjs$/u,
  /^dist\/cli\.mjs$/u,
  /^dist\/rewrite-process\.mjs$/u,
  /^dist\/prompts\/[^/]+\.prompt\.txt$/u,
  /^dist\/web\/server\/.+/u,
  /^dist\/web\/client\/.+/u,
  /^dist\/web\/guard\.js$/u,
]
const LIBRARY_LAYOUT = [/^package\.json$/u, /^README\.md$/u, /^LICENSE\.md$/u, /^dist\/.+\.(?:js|d\.ts|json)$/u]

// What no packed path may hold, whatever its package.
const FORBIDDEN_PATHS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\.map$/u, what: '.map' },
  { pattern: /(?<!\.d)\.ts$/u, what: '.ts' },
  { pattern: /(?:^|\/)\.env/u, what: '.env' },
  { pattern: /\.test\./u, what: '.test.' },
  { pattern: /\.spec\./u, what: '.spec.' },
  { pattern: /(?:^|\/)fixtures\//u, what: 'fixtures/' },
  { pattern: /(?:^|\/)testing\//u, what: 'testing/' },
  { pattern: /(?:^|\/)conformance\//u, what: 'conformance/' },
  { pattern: /(?:^|\/)source-writer\//u, what: 'source-writer/' },
  { pattern: /demo/u, what: 'demo' },
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const shown = (value: unknown): string => (value === undefined ? 'nothing' : JSON.stringify(value))

const isCli = (entry: IPublicPackage): boolean => entry.exports.length === 0

const stagedOf = (entry: IPublicPackage): string => `${entry.directory}/${STAGED}`

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

const manifestAt = async (path: string): Promise<Record<string, unknown>> => {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!isRecord(parsed)) {
    throw new Error(`${path} holds no manifest object.`)
  }
  return parsed
}

// Rule 1: every field of the table present and equal, and no field the table does not hold, scripts among them.
const fieldFindings = (
  entry: IPublicPackage,
  staged: Record<string, unknown>,
  expected: Record<string, unknown>,
  ownRules: readonly string[]
): string[] => {
  const at = `${entry.name}: package.json`
  const compared = Object.entries(expected).filter(([field]) => !ownRules.includes(field))
  return [
    ...compared.flatMap(([field, value]) => {
      if (!(field in staged)) {
        return [`${at} lacks ${field} [package/manifest-field]`]
      }
      return isDeepStrictEqual(staged[field], value)
        ? []
        : [`${at} ${field} is ${shown(staged[field])}, its table holds ${shown(value)} [package/manifest-field]`]
    }),
    ...Object.keys(staged)
      .filter((field) => !(field in expected) && !ownRules.includes(field))
      .map((field) => `${at} has ${field}, which its table does not hold [package/manifest-field]`),
  ]
}

const cliFindings = (entry: IPublicPackage, staged: Record<string, unknown>): string[] =>
  CLI_OWN_RULES.filter((field) => field in staged).map(
    (field) =>
      `${entry.name}: package.json has ${field}; the CLI is one bundle with nothing to install [package/cli-fields]`
  )

const exportFindings = (
  entry: IPublicPackage,
  staged: Record<string, unknown>,
  expected: Record<string, unknown>
): string[] => {
  const at = `${entry.name}: package.json exports`
  const exports = isRecord(staged.exports) ? staged.exports : {}
  const wanted = isRecord(expected.exports) ? expected.exports : {}
  return [
    ...Object.keys(exports)
      .filter((subpath) => !entry.exports.includes(subpath))
      .map((subpath) => `${at} ${subpath}, which ${PUBLIC_PACKAGES} does not hold as public [package/public-exports]`),
    ...Object.entries(wanted)
      .filter(([subpath, target]) => !isDeepStrictEqual(exports[subpath], target))
      .map(
        ([subpath, target]) =>
          `${at} ${subpath} is ${shown(exports[subpath])}, not ${shown(target)} [package/public-exports]`
      ),
  ]
}

const dependencyFindings = (
  entry: IPublicPackage,
  staged: Record<string, unknown>,
  imported: ReadonlySet<string>
): string[] => {
  const at = `${entry.name}: package.json dependencies`
  if (!isRecord(staged.dependencies)) {
    return [`${at} is ${shown(staged.dependencies)}, not an object [package/dependencies]`]
  }
  return Object.entries(staged.dependencies).flatMap(([name, version]) => [
    ...(name.startsWith(OWN_SCOPE) && imported.has(name)
      ? []
      : [`${at} name ${name}, which is not a ${OWN_SCOPE} package it imports [package/dependencies]`]),
    ...(version === VERSION ? [] : [`${at} name ${name} at ${shown(version)}, not ${VERSION} [package/dependencies]`]),
  ])
}

// Every subpath a published package's workspace manifest exports is in one of the list's two columns for it, so a
// subpath added for the workspace's tools is not stripped silently.
const subpathFindings = async (root: string, entry: IPublicPackage): Promise<string[]> => {
  const manifest = await manifestAt(join(root, entry.directory, 'package.json'))
  const exports = isRecord(manifest.exports) ? Object.keys(manifest.exports) : []
  return exports
    .filter((subpath) => !entry.exports.includes(subpath) && !entry.workspaceOnly.includes(subpath))
    .map(
      (subpath) =>
        `${entry.name}: ${entry.directory}/package.json exports ${subpath}, which ${PUBLIC_PACKAGES} holds neither as ` +
        'public nor as workspace-only [package/unlisted-subpath]'
    )
}

// The paths npm would pack from a staged directory.
const packedFiles = async (directory: string): Promise<string[]> => {
  const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: directory,
    maxBuffer: MAX_LISTING_BYTES,
  })
  const parsed: unknown = JSON.parse(stdout)
  const [packed] = Array.isArray(parsed) ? (parsed as unknown[]) : []
  if (!isRecord(packed) || !Array.isArray(packed.files)) {
    throw new Error(`npm pack --dry-run --json in ${directory} printed no file list.`)
  }
  return packed.files.map((file: unknown) => (isRecord(file) ? String(file.path) : '')).toSorted()
}

const isAsset = (entry: IPublicPackage, file: string): boolean =>
  entry.assets.some((asset) => (asset.endsWith('/') ? file.startsWith(asset) : file === asset))

// Rule 2: each packed file inside the package's layout, and none holding what no package may.
const fileFindings = (entry: IPublicPackage, files: readonly string[]): string[] =>
  files.flatMap((file) => {
    const at = `${entry.name}: ${file}`
    const layout = isCli(entry) ? CLI_LAYOUT : LIBRARY_LAYOUT
    const isInLayout = layout.some((pattern) => pattern.test(file)) || (!isCli(entry) && isAsset(entry, file))
    return [
      ...(isInLayout ? [] : [`${at} is outside the package's layout [package/layout]`]),
      ...FORBIDDEN_PATHS.filter(({ pattern }) => pattern.test(file)).map(
        ({ what }) => `${at} holds ${what} [package/forbidden-path]`
      ),
      ...(isCli(entry) && file.endsWith('.d.ts')
        ? [`${at} is a declaration file in the CLI [package/forbidden-path]`]
        : []),
    ]
  })

// Rules 1 and 2 of one staged package, and what rules 3 to 6 read of it.
const packageFindingsOf = async (
  root: string,
  entry: IPublicPackage,
  homepage: string
): Promise<{ findings: string[]; packed: IStagedPackage }> => {
  const directory = join(root, stagedOf(entry))
  const staged = await manifestAt(join(directory, 'package.json'))
  const files = await packedFiles(directory)
  const subpaths = await subpathFindings(root, entry)
  const packed = {
    name: entry.name,
    directory: stagedOf(entry),
    isCli: isCli(entry),
    files,
    dependencies: isRecord(staged.dependencies) ? Object.keys(staged.dependencies) : [],
  }
  if (isCli(entry)) {
    return {
      findings: [
        ...fieldFindings(entry, staged, await cliManifestOf(root), CLI_OWN_RULES),
        ...cliFindings(entry, staged),
        ...subpaths,
        ...fileFindings(entry, files),
      ],
      packed,
    }
  }
  const { manifest: expected } = await libraryStageOf(root, entry, homepage)
  return {
    findings: [
      ...fieldFindings(entry, staged, expected, LIBRARY_OWN_RULES),
      ...exportFindings(entry, staged, expected),
      ...dependencyFindings(entry, staged, await ownImportsOf(directory, files)),
      ...subpaths,
      ...fileFindings(entry, files),
    ],
    packed,
  }
}

// The staged directories present under packages/ and apps/.
const stagedDirectories = async (root: string): Promise<string[]> => {
  const parents = ['packages', 'apps']
  const children = await Promise.all(
    parents.map(async (parent) =>
      (await readdir(join(root, parent), { withFileTypes: true }))
        .filter((child) => child.isDirectory())
        .map((child) => `${parent}/${child.name}/${STAGED}`)
    )
  )
  const present = await Promise.all(
    children.flat().map(async (directory) => ((await exists(join(root, directory))) ? [directory] : []))
  )
  return present.flat().toSorted()
}

// The packages a staged manifest depends on; a package that is not staged has its own finding.
const dependsOn = async (root: string, entry: IPublicPackage, present: readonly string[]): Promise<string[]> => {
  if (!present.includes(stagedOf(entry))) {
    return []
  }
  const manifest = await manifestAt(join(root, stagedOf(entry), 'package.json'))
  return isRecord(manifest.dependencies) ? Object.keys(manifest.dependencies) : []
}

// Rule 7, the order: every listed package once, each after the packages it depends on, and the CLI last.
const orderFindings = async (
  root: string,
  listed: readonly IPublicPackage[],
  present: readonly string[]
): Promise<string[]> => {
  if (!(await exists(join(root, PUBLISH_ORDER)))) {
    return [`${PUBLISH_ORDER}: missing [package/publish-order]`]
  }
  const lines = (await readFile(join(root, PUBLISH_ORDER), 'utf8')).split('\n').filter((line) => line !== '')
  const positions = new Map(listed.map((entry) => [entry.name, lines.indexOf(stagedOf(entry))]))
  const at = `${PUBLISH_ORDER}:`
  const dependencies = await Promise.all(listed.map(async (entry) => dependsOn(root, entry, present)))
  return [
    ...lines
      .filter((line, index) => !listed.some((entry) => stagedOf(entry) === line) || lines.indexOf(line) !== index)
      .map(
        (line) => `${at} ${line} is not a package of ${PUBLIC_PACKAGES}, or is listed twice [package/publish-order]`
      ),
    ...listed.flatMap((entry, index) => {
      const position = positions.get(entry.name) ?? -1
      if (position === -1) {
        return [`${at} ${entry.name} is not listed [package/publish-order]`]
      }
      return [
        ...(dependencies[index] ?? [])
          .filter((name) => (positions.get(name) ?? -1) > position)
          .map((name) => `${at} ${entry.name} comes before ${name}, which it depends on [package/publish-order]`),
        ...(isCli(entry) && position !== lines.length - 1
          ? [`${at} ${entry.name} is not last [package/publish-order]`]
          : []),
      ]
    }),
  ]
}

// `pnpm check:package`: the staged packages' manifests, their packed files, what they bundle, import and hold, and the
// staged set and its publish order.
export const packageFindings = async (root: string): Promise<string[]> => {
  const listed = await publicPackagesIn(root)
  const present = await stagedDirectories(root)
  const homepage = await homepageOf(root)
  const staged = listed.filter((entry) => present.includes(stagedOf(entry)))
  const perPackage = await Promise.all(staged.map(async (entry) => packageFindingsOf(root, entry, homepage)))
  return [
    ...listed
      .filter((entry) => !present.includes(stagedOf(entry)))
      .map((entry) => `${entry.name}: ${stagedOf(entry)} is not staged [package/set]`),
    ...present
      .filter((directory) => !listed.some((entry) => stagedOf(entry) === directory))
      .map((directory) => `${directory}: staged, but ${PUBLIC_PACKAGES} does not list it [package/set]`),
    ...perPackage.flatMap(({ findings }) => findings),
    ...(await contentRuleFindings(
      root,
      perPackage.map(({ packed }) => packed)
    )),
    ...(await orderFindings(root, listed, present)),
  ]
}
