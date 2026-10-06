import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Where the notices are read from and written to, relative to the repository root.
const METAFILE = 'apps/cli/build/metafile.json'
const WEB_MODULES = 'apps/web/build/modules.json'
export const BUNDLED_PACKAGES = 'apps/cli/build/bundled-packages.json'
export const NOTICES = 'apps/cli/package/THIRD-PARTY-NOTICES.md'
// The licence texts the owner chose for packages that ship none, by name@version, each in a file beside the list.
export const LICENCE_TEXTS = 'packages/ci/src/rules/licence-texts.json'

const NODE_MODULES = 'node_modules/'
const OWN_SCOPE = '@log-book/'
const LICENCE_FILE = /^(?:licen[cs]e|copying)(?:\.[^.]+)?$/iu
const FENCE_MIN = 3
const BACKTICK_RUNS = /`+/gu

// One npm package whose code the CLI's package carries.
interface IBundledPackage {
  name: string
  version: string
  // The `license` field of its package.json, an SPDX expression.
  license: string
  // The licence text's file, relative to the repository root.
  licenseFile: string
  // Whether the package ships no licence file and the text is the one the owner chose for it.
  isChosenText: boolean
}

interface IChosenText {
  license: string
  file: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const chosenTextsOf = (text: string): ReadonlyMap<string, IChosenText> => {
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) {
    throw new Error(`${LICENCE_TEXTS} holds no object of name@version entries.`)
  }
  return new Map(
    Object.entries(parsed).map(([key, entry]) => {
      if (!isRecord(entry) || typeof entry.license !== 'string' || typeof entry.file !== 'string') {
        throw new Error(`${LICENCE_TEXTS} has an entry for ${key} without license or file.`)
      }
      return [key, { license: entry.license, file: entry.file }]
    })
  )
}

// The package directory a module path under node_modules lies in: the last node_modules segment and the package's
// name, scoped or not.
const packageDirectoryOf = (path: string): string => {
  const at = path.lastIndexOf(NODE_MODULES) + NODE_MODULES.length
  const [first = '', second = ''] = path.slice(at).split('/')
  return `${path.slice(0, at)}${first.startsWith('@') ? `${first}/${second}` : first}`
}

// Every npm package directory among the inputs, once, without Log Book's own.
const packageDirectoriesIn = (inputs: readonly string[]): string[] => [
  ...new Set(
    inputs
      .filter((path) => path.includes(NODE_MODULES))
      .map(packageDirectoryOf)
      .filter((directory) => !directory.slice(directory.lastIndexOf(NODE_MODULES)).includes(`/${OWN_SCOPE}`))
  ),
]

const packageOf = async (
  root: string,
  directory: string,
  chosen: ReadonlyMap<string, IChosenText>
): Promise<IBundledPackage> => {
  const manifest: unknown = JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8'))
  if (
    !isRecord(manifest) ||
    typeof manifest.name !== 'string' ||
    typeof manifest.version !== 'string' ||
    typeof manifest.license !== 'string'
  ) {
    throw new Error(`${directory}/package.json has no name, version or license as text.`)
  }
  const { name, version, license } = manifest
  const [file] = (await readdir(join(root, directory)))
    .filter((entry) => LICENCE_FILE.test(entry))
    .toSorted((left, right) => left.localeCompare(right))
  if (file !== undefined) {
    return { name, version, license, licenseFile: `${directory}/${file}`, isChosenText: false }
  }
  const text = chosen.get(`${name}@${version}`)
  if (text === undefined) {
    throw new Error(
      `${name} ${version} ships no licence file, and ${LICENCE_TEXTS} records no text for it. Which text to ship is ` +
        "the owner's decision."
    )
  }
  if (text.license !== license) {
    throw new Error(
      `${LICENCE_TEXTS} records ${text.license} for ${name} ${version}, whose package.json declares ${license}.`
    )
  }
  return { name, version, license, licenseFile: join(dirname(LICENCE_TEXTS), text.file), isChosenText: true }
}

// The npm packages whose code is in the CLI's dist/: what esbuild inlined, from its metafile, and what Astro's build
// inlined into the web app's server and client output, from the web build's record. In name, then version, order.
const bundledPackagesIn = async (root: string): Promise<IBundledPackage[]> => {
  const metafile = JSON.parse(await readFile(join(root, METAFILE), 'utf8')) as { inputs: Record<string, unknown> }
  const web = JSON.parse(await readFile(join(root, WEB_MODULES), 'utf8')) as { server: string[]; client: string[] }
  const chosen = chosenTextsOf(await readFile(join(root, LICENCE_TEXTS), 'utf8'))
  const directories = packageDirectoriesIn([...Object.keys(metafile.inputs), ...web.server, ...web.client])
  const packages = await Promise.all(directories.map(async (directory) => packageOf(root, directory, chosen)))
  const unique = new Map(packages.map((entry) => [`${entry.name}@${entry.version}`, entry]))
  return [...unique.values()].toSorted((left, right) => {
    const byName = left.name.localeCompare(right.name)
    return byName === 0 ? left.version.localeCompare(right.version) : byName
  })
}

// A fence longer than any run of backticks in the text, so the text stays inside it unchanged.
const fenceFor = (text: string): string =>
  '`'.repeat(Math.max(FENCE_MIN, ...[...text.matchAll(BACKTICK_RUNS)].map(([run]) => run.length + 1)))

const sectionOf = async (root: string, entry: IBundledPackage): Promise<string> => {
  const text = await readFile(join(root, entry.licenseFile), 'utf8')
  const fence = fenceFor(text)
  const chosen = entry.isChosenText
    ? `${entry.name} ships no licence file. The text below is the standard text of the licence its package.json ` +
      `declares, with its author as the copyright holder.\n\n`
    : ''
  return `## ${entry.name} ${entry.version}\n\nLicense: ${entry.license}\n\n${chosen}${fence}text\n${text.trimEnd()}\n${fence}\n`
}

// Writes the bundled package list beside the build and the notices into the CLI's package, after its bundle and its
// copy of the web app's build.
export const writeThirdParty = async (root: string): Promise<void> => {
  const packages = await bundledPackagesIn(root)
  const sections = await Promise.all(packages.map(async (entry) => sectionOf(root, entry)))
  await writeFile(
    join(root, BUNDLED_PACKAGES),
    `${JSON.stringify(
      packages.map(({ name, version, license, licenseFile }) => ({ name, version, license, licenseFile })),
      null,
      2
    )}\n`
  )
  await writeFile(
    join(root, NOTICES),
    `Log Book's package includes the following npm packages, each under its own licence.\n\n${sections.join('\n')}`
  )
}
