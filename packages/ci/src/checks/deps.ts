import { readFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { CI_PACKAGE, DEMO_PACKAGE, DEPENDENCY_RULE, type IDependencyRow } from '../rules/dependency-rule.js'
import { trackedFiles } from '../tracked-files.js'

interface IWorkspacePackage {
  name: string
  // Relative to the repository root, such as `packages/engine`.
  directory: string
  manifest: string
  fields: Readonly<Record<string, Readonly<Record<string, string>>>>
}

const RULE = '[dependency-rule]'
const WORKSPACE_SCOPE = '@log-book/'
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const
const DEV_FIELD = 'devDependencies'
const SCANNED = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|astro|vue)$/u
// The specifier of an import, an export from, a dynamic import or a require.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(?<quote>['"])(?<specifier>[^'"\n]+)\k<quote>/gu
const DOCS_CAPTURE = 'apps/docs/capture/'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const fieldsOf = (manifest: Record<string, unknown>): IWorkspacePackage['fields'] =>
  Object.fromEntries(
    DEPENDENCY_FIELDS.map((field) => {
      const value = manifest[field]
      return [field, isRecord(value) ? (value as Record<string, string>) : {}]
    })
  )

const packageOf = async (root: string, manifest: string): Promise<IWorkspacePackage> => {
  const parsed: unknown = JSON.parse(await readFile(join(root, manifest), 'utf8'))
  if (!isRecord(parsed) || typeof parsed.name !== 'string') {
    throw new Error(`${manifest} has no package name`)
  }
  return { name: parsed.name, directory: dirname(manifest), manifest, fields: fieldsOf(parsed) }
}

const rowOf = (pkg: IWorkspacePackage): IDependencyRow => {
  const row = DEPENDENCY_RULE[pkg.name]
  if (row === undefined) {
    throw new Error(`${pkg.manifest}: ${pkg.name} has no row in the dependency rule`)
  }
  return row
}

const declarationFinding = (pkg: IWorkspacePackage, field: string, name: string): string | null => {
  const at = `${pkg.manifest}: ${pkg.name}`
  if (name === CI_PACKAGE) {
    return `${at} may not depend on ${CI_PACKAGE} (${field}) ${RULE}`
  }
  if (name === DEMO_PACKAGE) {
    return field === DEV_FIELD ? null : `${at} may take ${DEMO_PACKAGE} only in ${DEV_FIELD}, not ${field} ${RULE}`
  }
  const row = rowOf(pkg)
  if (!row.mayImport.some((allowed) => allowed.name === name)) {
    return `${at} may not depend on ${name} (${field}) ${RULE}`
  }
  return row.isDevOnly === true && field !== DEV_FIELD
    ? `${at} may take ${name} only in ${DEV_FIELD}, not ${field} ${RULE}`
    : null
}

// Every workspace package a manifest declares that its row does not allow, in the field it declares it in.
const declarationFindings = (pkg: IWorkspacePackage): string[] =>
  DEPENDENCY_FIELDS.flatMap((field) =>
    Object.keys(pkg.fields[field] ?? {})
      .filter((name) => name.startsWith(WORKSPACE_SCOPE))
      .map((name) => declarationFinding(pkg, field, name))
      .filter((finding) => finding !== null)
  )

const isTestFile = (file: string, pkg: IWorkspacePackage): boolean =>
  file.endsWith('.test.ts') || file.startsWith(`${pkg.directory}/test/`) || file.startsWith(DOCS_CAPTURE)

// A workspace specifier's package and the subpath after it: `@log-book/cli/grammar` is `@log-book/cli` and `/grammar`.
const splitSpecifier = (specifier: string): { name: string; subpath: string } => {
  const [scope = '', name = '', ...rest] = specifier.split('/')
  return { name: `${scope}/${name}`, subpath: rest.length === 0 ? '' : `/${rest.join('/')}` }
}

const isWorkspaceImportAllowed = (specifier: string, file: string, pkg: IWorkspacePackage): boolean => {
  const { name, subpath } = splitSpecifier(specifier)
  if (name === pkg.name) {
    return true
  }
  if (name === DEMO_PACKAGE) {
    return isTestFile(file, pkg)
  }
  return rowOf(pkg).mayImport.some(
    (allowed) => allowed.name === name && (allowed.subpath === undefined || allowed.subpath === subpath)
  )
}

const specifierFinding = (specifier: string, file: string, pkg: IWorkspacePackage): string | null => {
  if (specifier.startsWith(WORKSPACE_SCOPE)) {
    return isWorkspaceImportAllowed(specifier, file, pkg) ? null : `${specifier} is not allowed in ${pkg.name}`
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const target = posix.normalize(posix.join(posix.dirname(file), specifier))
    return target.startsWith(`${pkg.directory}/`) ? null : `${specifier} reaches outside ${pkg.name}`
  }
  return null
}

// Every import of a file that its package's row does not allow, or that leaves its package by a relative path.
const importFindings = (file: string, text: string, pkg: IWorkspacePackage): string[] =>
  text.split('\n').flatMap((line, index) =>
    [...line.matchAll(SPECIFIER)].flatMap((match) => {
      const finding = specifierFinding(match.groups?.specifier ?? '', file, pkg)
      return finding === null ? [] : [`${file}:${String(index + 1)}: ${finding} ${RULE}`]
    })
  )

// The package a file belongs to: the one whose directory holds it, the deepest when two do.
const ownerOf = (file: string, packages: readonly IWorkspacePackage[]): IWorkspacePackage | undefined =>
  packages
    .filter((pkg) => file.startsWith(`${pkg.directory}/`))
    .toSorted((first, second) => second.directory.length - first.directory.length)[0]

// Every finding of the dependency rule in the repository at root: declarations, then imports, in file order.
export const dependencyFindings = async (root: string): Promise<string[]> => {
  const files = await trackedFiles(root, ['packages', 'apps'])
  const manifests = files.filter((file) => /^(?:packages|apps)\/[^/]+\/package\.json$/u.test(file))
  const packages = await Promise.all(manifests.map(async (manifest) => packageOf(root, manifest)))
  const sources = files.filter((file) => SCANNED.test(file))
  const imports = await Promise.all(
    sources.map(async (file) => {
      const pkg = ownerOf(file, packages)
      return pkg === undefined ? [] : importFindings(file, await readFile(join(root, file), 'utf8'), pkg)
    })
  )
  return [...packages.flatMap(declarationFindings), ...imports.flat()]
}
