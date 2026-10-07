import { execFile } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { quarantinedAt, type IQuarantined } from '../checks/tests.js'
import { schemaVersionAt } from './release-notes.js'

const run = promisify(execFile)
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

const REPOSITORY = 'developer239/logbook'
const PUBLIC_PACKAGES = 'packages/ci/src/rules/public-packages.json'
const REGISTRY = 'https://registry.npmjs.org'
const PROVENANCE = 'https://slsa.dev/provenance/v1'
// What every promoted version's provenance names: built by ci.yml on main of this repository.
const BUILT_BY = {
  repository: `https://github.com/${REPOSITORY}`,
  path: '.github/workflows/ci.yml',
  ref: 'refs/heads/main',
}
const MAIN = 'refs/heads/main'
const VERSION = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/u
const PULL_REQUEST = /\(#(?<number>\d+)\)$/u
const DISPATCH_WAIT_MS = 2000
const DISPATCH_TRIES = 30
// How far before the dispatch a run may say it started, for a clock that differs from GitHub's.
const CLOCK_MARGIN_MS = 30_000
const WRONG_ARGUMENTS = 2
const MACHINE_FLAGS = new Set(['--rollback', '--dry-run'])

export interface IRegistryAnswer {
  status: number
  body: unknown
}

// What the command reaches outside the repository: GitHub through gh, and the registry's JSON.
export interface IPromoteContext {
  root: string
  env: Readonly<Record<string, string | undefined>>
  stdout: (text: string) => void
  stderr: (text: string) => void
  gh: (args: readonly string[]) => Promise<string>
  registry: (url: string) => Promise<IRegistryAnswer>
}

interface IPromotion {
  version: string
  isRollback: boolean
  // The names of the published packages, in the public package list's order, which is the publish order.
  packages: string[]
  commit: string
  latest: string
}

class Refusal extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const git = async (root: string, args: readonly string[]): Promise<string> =>
  (await run('git', args, { cwd: root, maxBuffer: MAX_OUTPUT_BYTES })).stdout.trim()

const parts = (version: string): number[] => {
  const groups = VERSION.exec(version)?.groups
  return groups === undefined ? [] : [Number(groups.major), Number(groups.minor), Number(groups.patch)]
}

const isNewer = (version: string, than: string): boolean => {
  const [left, right] = [parts(version), parts(than)]
  const index = left.findIndex((part, at) => part !== right[at])
  return index !== -1 && (left[index] ?? 0) > (right[index] ?? 0)
}

const packagesIn = async (root: string): Promise<string[]> => {
  const parsed: unknown = JSON.parse(await readFile(join(root, PUBLIC_PACKAGES), 'utf8'))
  return Array.isArray(parsed) ? parsed.map((entry) => (isRecord(entry) ? String(entry.name) : '')) : []
}

// Check 1: on main in the workflow, a version of the form X.Y.Z, and its tag; the tag's commit.
const taggedCommit = async (root: string, version: string, ref: string | undefined): Promise<string> => {
  if (ref !== undefined && ref !== MAIN) {
    throw new Refusal(`promote.yml runs from main only; this run is on ${ref}.`)
  }
  if (!VERSION.test(version)) {
    throw new Refusal(`The version ${version} is not X.Y.Z.`)
  }
  try {
    return await git(root, ['rev-parse', '--verify', '--quiet', `refs/tags/v${version}^{commit}`])
  } catch {
    throw new Refusal(`There is no tag v${version}.`)
  }
}

// A record's field when the value is a record holding one, and an empty record otherwise.
const field = (value: unknown, name: string): Record<string, unknown> => {
  const found = isRecord(value) ? value[name] : undefined
  return isRecord(found) ? found : {}
}

// The in-toto statement of the slsa provenance among an attestations answer, or undefined when it holds none.
const slsaStatementOf = (body: unknown): unknown => {
  const attestations: unknown[] = isRecord(body) && Array.isArray(body.attestations) ? body.attestations : []
  const attestation = attestations.find((entry) => isRecord(entry) && entry.predicateType === PROVENANCE)
  const { payload } = field(field(attestation, 'bundle'), 'dsseEnvelope')
  return typeof payload === 'string' ? JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) : undefined
}

// The workflow the slsa provenance of a published version names and the commit it was built from, or undefined when
// the version has no such provenance.
const provenanceOf = (body: unknown): { workflow: Record<string, unknown>; commit: unknown } | undefined => {
  const statement = slsaStatementOf(body)
  if (statement === undefined) {
    return undefined
  }
  const definition = field(field(statement, 'predicate'), 'buildDefinition')
  const sources: unknown[] = Array.isArray(definition.resolvedDependencies) ? definition.resolvedDependencies : []
  return {
    workflow: field(definition.externalParameters, 'workflow'),
    commit: field(sources[0], 'digest').gitCommit,
  }
}

// Why one package's version may not be promoted, or undefined when it may.
const publishedRefusal = async (
  context: IPromoteContext,
  promotion: IPromotion,
  name: string
): Promise<string | undefined> => {
  const at = `${name}@${promotion.version}`
  const escaped = name.replace('/', '%2f')
  const [version, attestations] = await Promise.all([
    context.registry(`${REGISTRY}/${escaped}/${promotion.version}`),
    context.registry(`${REGISTRY}/-/npm/v1/attestations/${escaped}@${promotion.version}`),
  ])
  if (version.status !== 200) {
    return `${at} is not on npm: the registry answered ${String(version.status)}.`
  }
  const provenance = attestations.status === 200 ? provenanceOf(attestations.body) : undefined
  if (provenance === undefined) {
    return `${at} has no provenance, so it was published some other way, such as a placeholder.`
  }
  const wrong = Object.entries(BUILT_BY).filter(([key, expected]) => provenance.workflow[key] !== expected)
  if (wrong.length > 0) {
    const named = wrong.map(([key]) => `${key} ${String(provenance.workflow[key])}`).join(', ')
    return `${at}'s provenance names ${named}, not ${wrong.map(([key, expected]) => `${key} ${expected}`).join(', ')}.`
  }
  return provenance.commit === promotion.commit
    ? undefined
    : `${at} was built from ${String(provenance.commit)}, not from v${promotion.version} at ${promotion.commit}.`
}

// Check 2: every package has the version on npm, with provenance from ci.yml on main of this repository, built from the
// tagged commit. The first package in the list's order that may not is the one named.
const checkPublished = async (context: IPromoteContext, promotion: IPromotion): Promise<void> => {
  const refusals = await Promise.all(promotion.packages.map(async (name) => publishedRefusal(context, promotion, name)))
  const [refusal] = refusals.filter((found) => found !== undefined)
  if (refusal !== undefined) {
    throw new Refusal(refusal)
  }
}

// Check 3: every workflow run a push started on the tagged commit (ci.yml's) succeeded in its latest attempt, and no
// ci.yml run on main is unfinished. A dispatched run, such as promote.yml's own on that commit, is not a push's.
const checkRuns = async (context: IPromoteContext, promotion: IPromotion): Promise<void> => {
  const runs = await context.gh([
    'api',
    '--paginate',
    `repos/${REPOSITORY}/actions/runs?head_sha=${promotion.commit}&event=push&per_page=100`,
    '--jq',
    '.workflow_runs[] | [.name, .status, .conclusion // ""] | @tsv',
  ])
  const rows = runs
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split('\t'))
  const failed = rows.filter(([, status, conclusion]) => status !== 'completed' || conclusion !== 'success')
  if (rows.length === 0 || failed.length > 0) {
    throw new Refusal(
      rows.length === 0
        ? `No workflow run checked v${promotion.version}'s commit ${promotion.commit}.`
        : `Not every check of v${promotion.version} succeeded: ${failed.map(([name, status, conclusion]) => `${name ?? ''} ${conclusion === '' ? (status ?? '') : (conclusion ?? '')}`).join(', ')}.`
    )
  }
  const unfinished = await context.gh([
    'run',
    'list',
    '--repo',
    REPOSITORY,
    '--workflow',
    'ci.yml',
    '--branch',
    'main',
    '--limit',
    '20',
    '--json',
    'databaseId,status',
    '--jq',
    `[.[] | select(.status != "completed")] | length`,
  ])
  if (Number(unfinished.trim()) > 0) {
    throw new Refusal('A ci.yml run on main is unfinished; promote once it ends, so its verify job sees the move.')
  }
}

// The latest version every package shares.
const latestOf = async (context: IPromoteContext, packages: readonly string[]): Promise<string> => {
  const tags = await Promise.all(
    packages.map(async (name) => {
      const answer = await context.registry(`${REGISTRY}/-/package/${name}/dist-tags`)
      return isRecord(answer.body) ? String(answer.body.latest) : ''
    })
  )
  const latest = new Set(tags)
  const [only] = latest
  if (latest.size !== 1 || only === undefined) {
    throw new Refusal(
      `The packages' latest differ: ${packages.map((name, at) => `${name} ${tags[at] ?? ''}`).join(', ')}.`
    )
  }
  return only
}

const tagExists = async (root: string, version: string): Promise<boolean> =>
  git(root, ['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`]).then(
    () => true,
    () => false
  )

// Check 4: newer than latest, or with rollback no migration between the version and latest.
const checkDirection = async (root: string, promotion: IPromotion): Promise<void> => {
  const { version, latest } = promotion
  if (!promotion.isRollback) {
    if (!isNewer(version, latest)) {
      throw new Refusal(`${version} is not newer than latest, ${latest}; a rollback sets --rollback.`)
    }
    return
  }
  if (!(await tagExists(root, latest))) {
    return
  }
  const [from, to] = [await schemaVersionAt(root, `v${version}`), await schemaVersionAt(root, `v${latest}`)]
  if (to > from) {
    throw new Refusal(
      `Between ${version} and ${latest} the warehouse migrated from schema ${String(from)} to ${String(to)}, which ` +
        `${version} refuses with exit 6. Fix it forward with a fix: release and promote that.`
    )
  }
}

// What is about to reach users: the pull requests since latest's tag, the migration, and the quarantined tests.
const checklistOf = async (root: string, promotion: IPromotion): Promise<string> => {
  const target = `v${promotion.version}`
  const since = (await tagExists(root, promotion.latest)) ? `v${promotion.latest}` : null
  const subjects = await git(root, ['log', '--format=%s', since === null ? target : `${since}..${target}`])
  const pulls = subjects
    .split('\n')
    .filter((subject) => PULL_REQUEST.test(subject))
    .map(
      (subject) => `- #${PULL_REQUEST.exec(subject)?.groups?.number ?? ''} ${subject.replace(PULL_REQUEST, '').trim()}`
    )
  const [from, to] = [since === null ? 0 : await schemaVersionAt(root, since), await schemaVersionAt(root, target)]
  const quarantined: IQuarantined[] = await quarantinedAt(root, target)
  return [
    `# Promote ${promotion.version} to latest${promotion.isRollback ? ' (rollback)' : ''}`,
    '',
    `latest is ${promotion.latest} now. Packages: ${promotion.packages.join(', ')}.`,
    '',
    `## Pull requests since ${since ?? 'the first commit'}`,
    '',
    ...(pulls.length === 0 ? ['None'] : pulls.toReversed()),
    '',
    '## Warehouse migration',
    '',
    to > from ? `Schema ${String(from)} to ${String(to)}.` : 'None',
    '',
    '## Quarantined tests',
    '',
    ...(quarantined.length === 0
      ? ['None']
      : quarantined.map(({ file, name, issue }) => `- ${file}: ${name} (${issue})`)),
    '',
  ].join('\n')
}

// Checks 1 to 4 in order, stopping at the first that refuses, then the checklist.
const promotionOf = async (
  context: IPromoteContext,
  version: string,
  isRollback: boolean,
  ref: string | undefined
): Promise<IPromotion & { checklist: string }> => {
  const commit = await taggedCommit(context.root, version, ref)
  const packages = await packagesIn(context.root)
  const promotion = { version, isRollback, packages, commit, latest: '' }
  await checkPublished(context, promotion)
  await checkRuns(context, promotion)
  promotion.latest = await latestOf(context, packages)
  await checkDirection(context.root, promotion)
  return { ...promotion, checklist: await checklistOf(context.root, promotion) }
}

const outputTo = async (file: string | undefined, text: string): Promise<void> => {
  if (file === undefined || file === '') {
    throw new Error('promote --check runs under GitHub Actions, which sets GITHUB_OUTPUT and GITHUB_STEP_SUMMARY.')
  }
  await appendFile(file, text)
}

// The dispatched run: the newest promote.yml run named for the version that started after the dispatch, asked for
// again every few seconds until it appears.
const dispatchedRun = async (
  context: IPromoteContext,
  version: string,
  since: string,
  attempt = 0
): Promise<string> => {
  if (attempt === DISPATCH_TRIES) {
    throw new Error(`No promote.yml run for ${version} appeared after the dispatch.`)
  }
  const id = await context.gh([
    'run',
    'list',
    '--repo',
    REPOSITORY,
    '--workflow',
    'promote.yml',
    '--limit',
    '10',
    '--json',
    'databaseId,displayTitle,createdAt',
    '--jq',
    `[.[] | select(.displayTitle == "promote ${version}" and .createdAt >= "${since}")][0].databaseId // ""`,
  ])
  if (id.trim() !== '') {
    return id.trim()
  }
  await new Promise((resolve) => setTimeout(resolve, DISPATCH_WAIT_MS))
  return dispatchedRun(context, version, since, attempt + 1)
}

const dispatch = async (context: IPromoteContext, promotion: IPromotion): Promise<number> => {
  const since = new Date(Date.now() - CLOCK_MARGIN_MS).toISOString().replace(/\.\d+Z$/u, 'Z')
  await context.gh([
    'workflow',
    'run',
    'promote.yml',
    '--repo',
    REPOSITORY,
    '--ref',
    'main',
    '-f',
    `version=${promotion.version}`,
    '-f',
    `rollback=${String(promotion.isRollback)}`,
  ])
  const id = await dispatchedRun(context, promotion.version, since)
  context.stdout(`Dispatched promote.yml for ${promotion.version}: run ${id}\n`)
  try {
    await context.gh(['run', 'watch', id, '--repo', REPOSITORY, '--exit-status', '--interval', '10'])
    return 0
  } catch {
    context.stderr(`The promote.yml run ${id} failed; gh run view ${id} --repo ${REPOSITORY} shows why.\n`)
    return 1
  }
}

interface IArguments {
  version: string
  isRollback: boolean
  isCheck: boolean
  isDryRun: boolean
}

// The command's arguments, from the command line on a machine and from the environment with --check; null when wrong.
const argumentsOf = (args: readonly string[], env: IPromoteContext['env']): IArguments | null => {
  const flags = args.filter((arg) => arg.startsWith('--'))
  const positional = args.filter((arg) => !arg.startsWith('--'))
  if (flags.includes('--check')) {
    return flags.length === 1 && positional.length === 0
      ? { version: env.VERSION ?? '', isRollback: env.ROLLBACK === 'true', isCheck: true, isDryRun: true }
      : null
  }
  const [version] = positional
  return positional.length === 1 && version !== undefined && flags.every((flag) => MACHINE_FLAGS.has(flag))
    ? { version, isRollback: flags.includes('--rollback'), isCheck: false, isDryRun: flags.includes('--dry-run') }
    : null
}

// `promote X.Y.Z [--rollback] [--dry-run]` on a machine: the checks and the checklist, then the dispatch unless dry.
// `promote --check` in promote.yml's check job: the version and rollback from VERSION and ROLLBACK, the ref from
// GITHUB_REF, the checklist into the job summary and the outputs version and packages.
export const promote = async (args: readonly string[], context: IPromoteContext): Promise<number> => {
  const parsed = argumentsOf(args, context.env)
  if (parsed === null) {
    context.stderr('This command takes X.Y.Z [--rollback] [--dry-run], or --check with VERSION and ROLLBACK set.\n')
    return WRONG_ARGUMENTS
  }
  try {
    const ref = parsed.isCheck ? (context.env.GITHUB_REF ?? '') : undefined
    const promotion = await promotionOf(context, parsed.version, parsed.isRollback, ref)
    if (parsed.isCheck) {
      await outputTo(context.env.GITHUB_STEP_SUMMARY, `${promotion.checklist}\n`)
      await outputTo(
        context.env.GITHUB_OUTPUT,
        `version=${promotion.version}\npackages=${JSON.stringify(promotion.packages)}\n`
      )
      return 0
    }
    context.stdout(`${promotion.checklist}\n`)
    return parsed.isDryRun ? 0 : await dispatch(context, promotion)
  } catch (error) {
    if (error instanceof Refusal) {
      context.stderr(`${error.message}\n`)
      return 1
    }
    throw error
  }
}
