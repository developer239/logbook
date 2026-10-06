import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { homepageOf } from './published-fields.js'

// One package of the published set, as packages/ci/src/rules/public-packages.json lists it.
export interface IPublicPackage {
  name: string
  directory: string
  description: string
  // Its public entries, such as `.`; a package with none is staged elsewhere, as the CLI's bundle is.
  exports: string[]
  workspaceOnly: string[]
  // Files under dist/ its public code reaches by path at runtime rather than by import: a module it starts as a process,
  // traced through its own imports, or a file or directory it reads, such as the engine's prompts.
  assets: string[]
}

interface IWorkspaceManifest {
  exports: Record<string, { types: string; default: string }>
  dependencies: Record<string, string>
}

export const PUBLIC_PACKAGES = 'packages/ci/src/rules/public-packages.json'
export const PUBLISH_ORDER = 'build/publish-order.txt'
export const STAGED = 'package'
const LICENSE = 'LICENSE.md'
const VERSION = '0.0.0-development'
const OWN_SCOPE = '@log-book/'
const REPOSITORY = 'https://github.com/developer239/logbook'
// A relative module specifier after `from`, `import` or `import(`, as tsc writes them.
const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](?<specifier>\.\.?\/[^'"]+)['"]/gu
// A @log-book package a module or declaration file names, after `from`, `import`, `import(` or `require(`.
const OWN_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"](?<name>@log-book\/[^'"/]+)/gu
const CODE = /\.(?:js|d\.ts)$/u

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

// The public package list, refused when an entry lacks a field.
const publicPackagesOf = (text: string): IPublicPackage[] => {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) {
    throw new Error(`${PUBLIC_PACKAGES} holds no list of packages.`)
  }
  return parsed.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      typeof entry.directory !== 'string' ||
      typeof entry.description !== 'string' ||
      !isStringList(entry.exports) ||
      !isStringList(entry.workspaceOnly) ||
      !isStringList(entry.assets)
    ) {
      throw new Error(
        `${PUBLIC_PACKAGES} has an entry without name, directory, description, exports, workspaceOnly or assets.`
      )
    }
    return {
      name: entry.name,
      directory: entry.directory,
      description: entry.description,
      exports: entry.exports,
      workspaceOnly: entry.workspaceOnly,
      assets: entry.assets,
    }
  })
}

// The public package list of the repository at root.
export const publicPackagesIn = async (root: string): Promise<IPublicPackage[]> =>
  publicPackagesOf(await readFile(join(root, PUBLIC_PACKAGES), 'utf8'))

const workspaceManifestOf = (text: string, name: string): IWorkspaceManifest => {
  const parsed: unknown = JSON.parse(text)
  const exports = isRecord(parsed) ? parsed.exports : undefined
  const dependencies = isRecord(parsed) ? (parsed.dependencies ?? {}) : undefined
  if (!isRecord(exports) || !isRecord(dependencies)) {
    throw new Error(`${name}'s package.json has no exports object.`)
  }
  return {
    exports: exports as IWorkspaceManifest['exports'],
    dependencies: Object.fromEntries(Object.entries(dependencies).map(([key, value]) => [key, String(value)])),
  }
}

// A module a file names, relative to the package: a declaration file names its siblings' declarations by their .js
// names.
const resolved = (file: string, specifier: string): string => {
  const target = posix.normalize(posix.join(posix.dirname(file), specifier))
  return file.endsWith('.d.ts') && target.endsWith('.js') ? `${target.slice(0, -'.js'.length)}.d.ts` : target
}

// Every file the entries reach through their relative imports, JavaScript through JavaScript, declarations through
// declarations, and JSON modules both import.
const reachableFrom = async (packageDirectory: string, entries: readonly string[]): Promise<Set<string>> => {
  const reached = new Set<string>()
  const visit = async (file: string): Promise<void> => {
    if (reached.has(file)) {
      return
    }
    reached.add(file)
    if (file.endsWith('.json')) {
      return
    }
    const text = await readFile(join(packageDirectory, file), 'utf8')
    const specifiers = [...text.matchAll(RELATIVE_SPECIFIER)].map((match) => match.groups?.specifier ?? '')
    await Promise.all(specifiers.map(async (specifier) => visit(resolved(file, specifier))))
  }
  await Promise.all(entries.map(async (entry) => visit(entry)))
  return reached
}

const stripped = (path: string): string => path.replace(/^\.\//u, '')

// The @log-book packages these files of a package directory import, by name.
export const ownImportsOf = async (directory: string, files: readonly string[]): Promise<Set<string>> => {
  const texts = await Promise.all(
    files.filter((file) => CODE.test(file)).map(async (file) => readFile(join(directory, file), 'utf8'))
  )
  return new Set(texts.flatMap((text) => [...text.matchAll(OWN_SPECIFIER)].map((match) => match.groups?.name ?? '')))
}

// The published manifest of a library: exactly these fields, its public entries, the site as its homepage, and the
// @log-book dependencies of its workspace manifest that its staged files import, at the set's one version.
const libraryManifest = (
  entry: IPublicPackage,
  workspace: IWorkspaceManifest,
  homepage: string,
  imported: ReadonlySet<string>
): Record<string, unknown> => {
  const foreign = Object.keys(workspace.dependencies).filter((name) => !name.startsWith(OWN_SCOPE))
  if (foreign.length > 0) {
    throw new Error(`${entry.name} depends on ${foreign.join(', ')}, which a published library may not.`)
  }
  return {
    name: entry.name,
    description: entry.description,
    version: VERSION,
    license: 'PolyForm-Noncommercial-1.0.0',
    type: 'module',
    engines: { node: '>=24.15' },
    exports: Object.fromEntries(
      entry.exports.map((subpath) => {
        const target = workspace.exports[subpath]
        if (target === undefined) {
          throw new Error(`${entry.name} lists the public entry ${subpath}, which its package.json does not export.`)
        }
        return [subpath, { types: target.types, default: target.default }]
      })
    ),
    files: ['dist/'],
    homepage,
    repository: { type: 'git', url: `git+${REPOSITORY}.git`, directory: entry.directory },
    bugs: `${REPOSITORY}/issues`,
    publishConfig: { access: 'public' },
    dependencies: Object.fromEntries(
      Object.keys(workspace.dependencies)
        .filter((name) => imported.has(name))
        .toSorted()
        .map((name) => [name, VERSION])
    ),
  }
}

// What the stage writes for a library: the dist/ files its public entries and asset modules reach, and its manifest.
interface ILibraryStage {
  entry: IPublicPackage
  files: string[]
  dependsOn: string[]
  manifest: Record<string, unknown>
}

export const libraryStageOf = async (root: string, entry: IPublicPackage, homepage: string): Promise<ILibraryStage> => {
  const packageDirectory = join(root, entry.directory)
  const workspace = workspaceManifestOf(await readFile(join(packageDirectory, 'package.json'), 'utf8'), entry.name)
  const entries = entry.exports.flatMap((subpath) => {
    const target = workspace.exports[subpath]
    return target === undefined ? [] : [stripped(target.default), stripped(target.types)]
  })
  const modules = entry.assets.filter((asset) => asset.endsWith('.js'))
  const files = [...(await reachableFrom(packageDirectory, [...entries, ...modules]))].toSorted()
  const imported = await ownImportsOf(packageDirectory, files)
  return {
    entry,
    files,
    dependsOn: Object.keys(workspace.dependencies).filter((name) => imported.has(name)),
    manifest: libraryManifest(entry, workspace, homepage, imported),
  }
}

const readmeOf = (entry: IPublicPackage): string =>
  `# ${entry.name}\n\n${entry.description}.\n\nPart of Log Book, and versioned with every other \`@log-book\` package: ${REPOSITORY}\n`

// The staged directories in the order they publish: each library after the libraries it depends on, ties in name
// order, and the CLI last; a cycle stops the stage, naming its packages.
export const publishOrder = (
  libraries: readonly { name: string; directory: string; dependsOn: readonly string[] }[],
  cli: string
): string[] => {
  const order: string[] = []
  const placed = new Set<string>()
  let waiting = [...libraries].toSorted((left, right) => left.name.localeCompare(right.name))
  while (waiting.length > 0) {
    const ready = waiting.filter((library) =>
      library.dependsOn.every((name) => placed.has(name) || !libraries.some((other) => other.name === name))
    )
    const [next] = ready
    if (next === undefined) {
      throw new Error(
        `These packages depend on each other in a cycle: ${waiting.map((library) => library.name).join(', ')}.`
      )
    }
    order.push(`${next.directory}/${STAGED}`)
    placed.add(next.name)
    waiting = waiting.filter((library) => library !== next)
  }
  return [...order, `${cli}/${STAGED}`]
}

const stageLibrary = async (root: string, { entry, files, manifest }: ILibraryStage): Promise<void> => {
  const packageDirectory = join(root, entry.directory)
  const staged = join(packageDirectory, STAGED)
  await rm(staged, { recursive: true, force: true })
  await Promise.all(
    files.map(async (file) => {
      await mkdir(dirname(join(staged, file)), { recursive: true })
      await cp(join(packageDirectory, file), join(staged, file))
    })
  )
  await Promise.all([
    ...entry.assets
      .filter((asset) => !asset.endsWith('.js'))
      .map(async (asset) => cp(join(packageDirectory, asset), join(staged, asset), { recursive: true })),
    cp(join(root, LICENSE), join(staged, LICENSE)),
    writeFile(join(staged, 'README.md'), readmeOf(entry)),
    writeFile(join(staged, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`),
  ])
}

// `pnpm stage`, after the CLI: writes packages/<name>/package/ for every library of the public package list, holding
// only what its public entries reach, and build/publish-order.txt, which every release job reads.
export const stageLibraries = async (givenRoot: string): Promise<void> => {
  const root = await realpath(givenRoot)
  const listed = await publicPackagesIn(root)
  const libraries = listed.filter((entry) => entry.exports.length > 0)
  const cli = listed.find((entry) => entry.exports.length === 0)
  if (cli === undefined) {
    throw new Error(`${PUBLIC_PACKAGES} lists no package without public entries, the CLI.`)
  }
  const homepage = await homepageOf(root)
  const stages = await Promise.all(libraries.map(async (entry) => libraryStageOf(root, entry, homepage)))
  const order = publishOrder(
    stages.map(({ entry, dependsOn }) => ({ name: entry.name, directory: entry.directory, dependsOn })),
    cli.directory
  )
  await Promise.all(stages.map(async (stage) => stageLibrary(root, stage)))
  await mkdir(join(root, dirname(PUBLISH_ORDER)), { recursive: true })
  await writeFile(join(root, PUBLISH_ORDER), `${order.join('\n')}\n`)
}
