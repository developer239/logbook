import { readdir, readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { join } from 'node:path'
import { LICENCE_ALLOWLIST } from '../rules/licence-allowlist.js'
import { KNOWN_TOOL_NAMES, OWNER_LITERALS } from '../rules/owner-literals.js'
import { BUNDLED_PACKAGES, NOTICES } from '../stage/third-party.js'

const METAFILE = 'apps/cli/build/metafile.json'
const CORPUS = 'packages/demo/src/corpus'
const CORPUS_MARK = /^log-book-demo-corpus-[0-9a-f]{32}$/u
const FONTS = 'dist/web/client/fonts/'
const FONT_FILE = /\.(?:woff2?|ttf|otf)$/u
const FONT_LICENCE = 'Geist-OFL.txt'
const OWN_SCOPE = '@log-book/'
// The one absolute home path a package may hold: the checkout CI builds the published packages in.
const CI_WORKSPACE = '/home/runner/work/logbook/logbook/'
const HOME_PATH = /\/(?:Users|home)\/[^/\s"'`]*\/?/gu
const CODE = /^dist\/.+\.(?:js|mjs|cjs|d\.ts)$/u
// A quoted specifier after from, import, or a require call, whatever a bundler renamed it to (`__require`,
// `require$2`). A specifier holds no whitespace, `$`, braces, parentheses or angle brackets, so prose and template text
// that happen to follow those words are not read as imports.
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\b[\w$]*require(?:\$\d+)?\s*\(\s*)(?<quote>['"])(?<specifier>[^'"\s${}()<>]+)\k<quote>/gu
const IMAGE_PATH = /^(?:sharp(?:\/|$)|@img\/)/u
const SPDX_TOKEN = /[()]|[^\s()]+/gu

// What the CLI's bundle may not hold: the demo, the CI tooling, test files, and the workspace-only entries of the
// adapters and the warehouse.
const FORBIDDEN_MODULES: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /^packages\/demo\//u, what: 'the demo' },
  { pattern: /^packages\/ci\//u, what: 'the CI tooling' },
  { pattern: /\/testing\//u, what: 'a /testing/ path' },
  { pattern: /\/conformance\//u, what: 'a /conformance/ path' },
  { pattern: /\/source-writer\//u, what: 'a /source-writer/ path' },
  { pattern: /\.(?:test|spec)\.[^/]+$/u, what: 'a test file' },
]

interface IBundledEntry {
  name: string
  version: string
  license: string
}

export interface IStagedPackage {
  name: string
  // The staged directory, relative to the repository root.
  directory: string
  isCli: boolean
  // The packed paths, relative to the staged directory.
  files: readonly string[]
  // The staged manifest's dependencies, by name.
  dependencies: readonly string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const jsonAt = async (root: string, path: string): Promise<unknown> =>
  JSON.parse(await readFile(join(root, path), 'utf8'))

const bundledEntriesIn = async (root: string): Promise<IBundledEntry[]> => {
  const parsed = await jsonAt(root, BUNDLED_PACKAGES)
  if (!Array.isArray(parsed)) {
    throw new Error(`${BUNDLED_PACKAGES} holds no list of packages.`)
  }
  return parsed.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.version !== 'string') {
      throw new Error(`${BUNDLED_PACKAGES} has an entry without a name and a version.`)
    }
    return { name: entry.name, version: entry.version, license: String(entry.license) }
  })
}

// Whether an SPDX expression is allowed: an id when the list holds it (an exception after WITH changes nothing), an OR
// when one side is, an AND when both are. AND binds tighter than OR, and an expression that does not parse is not.
const isAllowedLicence = (expression: string): boolean => {
  const tokens = [...expression.matchAll(SPDX_TOKEN)].map(([token]) => token)
  let at = 0
  const next = (): string | undefined => {
    at += 1
    return tokens[at - 1]
  }
  const atom = (): boolean | null => {
    const token = next()
    if (token === '(') {
      const inner = either()
      return next() === ')' ? inner : null
    }
    if (token === undefined || token === ')' || token === 'AND' || token === 'OR') {
      return null
    }
    if (tokens[at] === 'WITH') {
      at += 2
    }
    return LICENCE_ALLOWLIST.includes(token)
  }
  const both = (): boolean | null => {
    let allowed = atom()
    while (allowed !== null && tokens[at] === 'AND') {
      at += 1
      const right = atom()
      allowed = right === null ? null : allowed && right
    }
    return allowed
  }
  const either = (): boolean | null => {
    let allowed = both()
    while (allowed !== null && tokens[at] === 'OR') {
      at += 1
      const right = both()
      allowed = right === null ? null : allowed || right
    }
    return allowed
  }
  const allowed = either()
  return allowed === true && at === tokens.length
}

// Rule 3: the modules of the CLI's bundle, from esbuild's metafile, and the licences of the npm packages in it.
const bundleFindings = async (root: string, cli: string): Promise<string[]> => {
  const metafile = await jsonAt(root, METAFILE)
  const inputs = isRecord(metafile) && isRecord(metafile.inputs) ? Object.keys(metafile.inputs) : []
  const packages = await bundledEntriesIn(root)
  return [
    ...inputs.flatMap((input) =>
      FORBIDDEN_MODULES.filter(({ pattern }) => pattern.test(input)).map(
        ({ what }) => `${cli}: dist/cli.mjs bundles ${input}, ${what} [package/bundle]`
      )
    ),
    ...packages
      .filter((entry) => !isAllowedLicence(entry.license))
      .map(
        (entry) =>
          `${cli}: bundles ${entry.name} ${entry.version}, licensed ${entry.license}, which the allowlist in ` +
          `packages/ci/src/rules/licence-allowlist.ts does not hold; a new licence is the owner's decision ` +
          '[package/licence]'
      ),
  ]
}

const isAllowedImport = (staged: IStagedPackage, specifier: string): boolean => {
  if (specifier.startsWith('./') || specifier.startsWith('../') || isBuiltin(specifier)) {
    return true
  }
  const [scope = '', name = ''] = specifier.split('/')
  return !staged.isCli && specifier.startsWith(OWN_SCOPE) && staged.dependencies.includes(`${scope}/${name}`)
}

const importFinding = (staged: IStagedPackage, file: string, specifier: string): string => {
  const at = `${staged.name}: ${file} imports ${specifier}`
  if (IMAGE_PATH.test(specifier)) {
    return (
      `${at}, Astro's image optimisation path: the web app's Astro configuration must keep the no-op image service ` +
      '(passthroughImageService()), since the default one needs @img/* packages no user has installed [package/imports]'
    )
  }
  return staged.isCli
    ? `${at}, which is neither relative nor a Node built-in [package/imports]`
    : `${at}, which is neither relative, a Node built-in nor a ${OWN_SCOPE} package its manifest lists [package/imports]`
}

// Rule 4: every specifier a code file under dist/ imports or requires.
const importFindings = async (root: string, staged: IStagedPackage): Promise<string[]> => {
  const findings = await Promise.all(
    staged.files
      .filter((file) => CODE.test(file))
      .map(async (file) => {
        const text = await readFile(join(root, staged.directory, file), 'utf8')
        const specifiers = new Set([...text.matchAll(SPECIFIER)].map((match) => match.groups?.specifier ?? ''))
        return [...specifiers]
          .filter((specifier) => !isAllowedImport(staged, specifier))
          .map((specifier) => importFinding(staged, file, specifier))
      })
  )
  return findings.flat()
}

// Rule 5: a notices section for every bundled npm package, and the font licence beside the fonts.
const noticeFindings = async (root: string, cli: IStagedPackage): Promise<string[]> => {
  const notices = (await readFile(join(root, NOTICES), 'utf8')).split('\n')
  const packages = await bundledEntriesIn(root)
  const hasFonts = cli.files.some((file) => file.startsWith(FONTS) && FONT_FILE.test(file))
  return [
    ...packages
      .filter((entry) => !notices.includes(`## ${entry.name} ${entry.version}`))
      .map(
        (entry) =>
          `${cli.name}: THIRD-PARTY-NOTICES.md has no section for ${entry.name} ${entry.version} [package/notices]`
      ),
    ...(hasFonts && !cli.files.includes(`${FONTS}${FONT_LICENCE}`)
      ? [`${cli.name}: ${FONTS} holds fonts without ${FONT_LICENCE} [package/notices]`]
      : []),
  ]
}

const stringsIn = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return [value]
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsIn)
  }
  return isRecord(value) ? Object.values(value).flatMap(stringsIn) : []
}

// The demo corpus mark, read from the corpus's JSON files as data: the demo is never imported here.
const corpusMarkIn = async (root: string): Promise<string> => {
  const files = (await readdir(join(root, CORPUS), { recursive: true })).filter((file) => file.endsWith('.json'))
  const values = await Promise.all(files.map(async (file) => stringsIn(await jsonAt(root, join(CORPUS, file)))))
  const marks = [...new Set(values.flat().filter((value) => CORPUS_MARK.test(value)))]
  const [mark] = marks
  if (marks.length !== 1 || mark === undefined) {
    throw new Error(
      `${CORPUS}: its JSON files hold ${String(marks.length)} values of the corpus mark's form, not exactly one.`
    )
  }
  return mark
}

const escaped = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)

// The known tool names, which the adapters' known-tool table ships and the CLI bundles, blanked out before the owner
// literals are looked for, as in the tracked files' check.
const KNOWN_TOOLS = new RegExp(String.raw`\b(?:${KNOWN_TOOL_NAMES.map(escaped).join('|')})\b`, 'giu')

const contentFindingsOf = (name: string, file: string, bytes: Buffer, mark: string): string[] => {
  const text = bytes.toString('latin1')
  const scanned = text.replaceAll(KNOWN_TOOLS, (found) => ' '.repeat(found.length)).toLowerCase()
  const homes = new Set(
    [...text.matchAll(HOME_PATH)].filter((match) => !text.startsWith(CI_WORKSPACE, match.index)).map(([found]) => found)
  )
  return [
    ...OWNER_LITERALS.filter((literal) => scanned.includes(literal.toLowerCase())).map(
      (literal) => `${name}: ${file} holds ${literal}, an owner-specific literal [package/owner-literal]`
    ),
    ...(text.includes(mark) ? [`${name}: ${file} holds the demo corpus mark [package/corpus-mark]`] : []),
    ...[...homes].map((found) => `${name}: ${file} holds the absolute home path ${found} [package/home-path]`),
  ]
}

// Rule 6: the bytes of every packed file.
const contentFindings = async (root: string, staged: IStagedPackage, mark: string): Promise<string[]> => {
  const findings = await Promise.all(
    staged.files.map(async (file) =>
      contentFindingsOf(staged.name, file, await readFile(join(root, staged.directory, file)), mark)
    )
  )
  return findings.flat()
}

// Rules 3 to 6 over the staged packages: what the CLI bundles and under which licences, what each package imports, the
// CLI's notices, and the bytes of every packed file.
export const contentRuleFindings = async (root: string, packages: readonly IStagedPackage[]): Promise<string[]> => {
  const mark = await corpusMarkIn(root)
  const cli = packages.find((staged) => staged.isCli)
  const perPackage = await Promise.all(
    packages.map(async (staged) => [
      ...(await importFindings(root, staged)),
      ...(await contentFindings(root, staged, mark)),
    ])
  )
  return [
    ...(cli === undefined ? [] : [...(await bundleFindings(root, cli.name)), ...(await noticeFindings(root, cli))]),
    ...perPackage.flat(),
  ]
}
