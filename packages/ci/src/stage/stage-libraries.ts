import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { homepageOf } from './published-fields.js'

// One package of the published set, as packages/ci/src/rules/public-packages.json lists it.
interface IPublicPackage {
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

const PUBLIC_PACKAGES = 'packages/ci/src/rules/public-packages.json'
const PUBLISH_ORDER = 'build/publish-order.txt'
const STAGED = 'package'
const LICENSE = 'LICENSE.md'
const VERSION = '0.0.0-development'
const OWN_SCOPE = '@log-book/'
const REPOSITORY = 'https://github.com/developer239/logbook'
// A relative module specifier after `from`, `import` or `import(`, as tsc writes them.
const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](?<specifier>\.\.?\/[^'"]+)['"]/gu

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

// The published manifest of a library: exactly these fields, its public entries, the site as its homepage, and its
// @log-book dependencies at the set's one version.
const libraryManifest = (
  entry: IPublicPackage,
  workspace: IWorkspaceManifest,
  homepage: string
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
    engines: { node: '>=24' },
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
        .toSorted()
        .map((name) => [name, VERSION])
    ),
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

const stageLibrary = async (
  root: string,
  entry: IPublicPackage,
  workspace: IWorkspaceManifest,
  homepage: string
): Promise<void> => {
  const packageDirectory = join(root, entry.directory)
  const staged = join(packageDirectory, STAGED)
  await rm(staged, { recursive: true, force: true })
  const entries = entry.exports.flatMap((subpath) => {
    const target = workspace.exports[subpath]
    return target === undefined ? [] : [stripped(target.default), stripped(target.types)]
  })
  const modules = entry.assets.filter((asset) => asset.endsWith('.js'))
  const files = await reachableFrom(packageDirectory, [...entries, ...modules])
  await Promise.all(
    [...files].map(async (file) => {
      await mkdir(dirname(join(staged, file)), { recursive: true })
      await cp(join(packageDirectory, file), join(staged, file))
    })
  )
  await Promise.all([
    ...entry.assets
      .filter((asset) => !modules.includes(asset))
      .map(async (asset) => cp(join(packageDirectory, asset), join(staged, asset), { recursive: true })),
    cp(join(root, LICENSE), join(staged, LICENSE)),
    writeFile(join(staged, 'README.md'), readmeOf(entry)),
    writeFile(
      join(staged, 'package.json'),
      `${JSON.stringify(libraryManifest(entry, workspace, homepage), null, 2)}\n`
    ),
  ])
}

// `pnpm stage`, after the CLI: writes packages/<name>/package/ for every library of the public package list, holding
// only what its public entries reach, and build/publish-order.txt, which every release job reads.
export const stageLibraries = async (givenRoot: string): Promise<void> => {
  const root = await realpath(givenRoot)
  const listed = publicPackagesOf(await readFile(join(root, PUBLIC_PACKAGES), 'utf8'))
  const libraries = listed.filter((entry) => entry.exports.length > 0)
  const cli = listed.find((entry) => entry.exports.length === 0)
  if (cli === undefined) {
    throw new Error(`${PUBLIC_PACKAGES} lists no package without public entries, the CLI.`)
  }
  const manifests = await Promise.all(
    libraries.map(async (entry) =>
      workspaceManifestOf(await readFile(join(root, entry.directory, 'package.json'), 'utf8'), entry.name)
    )
  )
  const homepage = await homepageOf(root)
  const order = publishOrder(
    libraries.map((entry, index) => ({
      name: entry.name,
      directory: entry.directory,
      dependsOn: Object.keys(manifests[index]?.dependencies ?? {}),
    })),
    cli.directory
  )
  await Promise.all(
    libraries.map(async (entry, index) => {
      const manifest = manifests[index]
      if (manifest !== undefined) {
        await stageLibrary(root, entry, manifest, homepage)
      }
    })
  )
  await mkdir(join(root, dirname(PUBLISH_ORDER)), { recursive: true })
  await writeFile(join(root, PUBLISH_ORDER), `${order.join('\n')}\n`)
}
