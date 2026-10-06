import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isNode, parse, parseDocument } from 'yaml'
import { RELEASE_CONFIG, RELEASE_CONFIG_FILE } from '../rules/release-config.js'
import { trackedFiles } from '../tracked-files.js'

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/u
const MANIFEST = /^(?:packages|apps)\/[^/]+\/package\.json$/u
const WRITE_ALL = 'write-all'
const NPM_ENVIRONMENTS = new Set(['npm-next', 'npm-latest'])
// Text no workflow may hold anywhere, comments included, until a release ticket allows it for one job.
const FORBIDDEN_TEXT = [
  'npm publish',
  'npm-cli.js',
  'npm dist-tag',
  '--tag latest',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'pull_request_target',
]
const SECRET = /\bsecrets\.(?<name>[A-Za-z_][A-Za-z0-9_]*)/gu
const ALLOWED_SECRET = 'GITHUB_TOKEN'
// The one job that may hold the right to publish: ci.yml's job publish, equal to the template but for the commit SHAs
// of its two actions, which must be full SHAs. Within it alone, the text may run npm publish through npm-cli.js.
const PUBLISH_WORKFLOW = '.github/workflows/ci.yml'
const PUBLISH_JOB = 'publish'
const PUBLISH_JOB_TEMPLATE = 'packages/ci/src/rules/publish-job.yaml'
const PUBLISH_TEXT = new Set(['npm publish', 'npm-cli.js'])
const PINNED_ACTIONS = ['actions/setup-node', 'actions/download-artifact']
const FULL_SHA = /^[0-9a-f]{40}$/u
const ANY_SHA = '<sha>'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

// Whether a permissions value grants this write: `write-all`, or the permission set to `write`.
const grants = (permissions: unknown, name: string): boolean =>
  permissions === WRITE_ALL || (isRecord(permissions) && permissions[name] === 'write')

const environmentOf = (job: Record<string, unknown>): unknown =>
  isRecord(job.environment) ? job.environment.name : job.environment

// The rights a job holds: its own permissions, or the workflow's when it has none.
const jobFindings = (file: string, workflow: Record<string, unknown>, id: string, job: unknown): string[] => {
  if (!isRecord(job)) {
    return []
  }
  const at = `${file}: job ${id}:`
  const permissions = 'permissions' in job ? job.permissions : workflow.permissions
  const environment = environmentOf(job)
  return [
    ...(grants(permissions, 'id-token') ? [`${at} id-token: write [release-guard/no-id-token]`] : []),
    ...(grants(permissions, 'contents') ? [`${at} contents: write [release-guard/no-contents-write]`] : []),
    ...(typeof environment === 'string' && NPM_ENVIRONMENTS.has(environment)
      ? [`${at} environment ${environment} [release-guard/no-npm-environment]`]
      : []),
  ]
}

// A step's `uses` of a pinned action, split into the action and its ref; undefined for any other value.
const pinnedUse = (value: unknown): { action: string; ref: string } | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const [action = '', ref = ''] = value.split('@')
  return PINNED_ACTIONS.includes(action) ? { action, ref } : undefined
}

// The job with the refs of its pinned actions replaced, so the template and the job compare without their SHAs.
const withoutShas = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => withoutShas(item))
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutShas(item)]))
  }
  const pinned = pinnedUse(value)
  return pinned === undefined ? value : `${pinned.action}@${ANY_SHA}`
}

// The path of the first place two values differ, or undefined when they are equal.
const firstDifference = (actual: unknown, expected: unknown, path: string): string | undefined => {
  if (isDeepStrictEqual(actual, expected)) {
    return undefined
  }
  if (Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length) {
    return expected
      .map((item, index) => firstDifference(actual[index], item, `${path}[${String(index)}]`))
      .find((difference) => difference !== undefined)
  }
  if (isRecord(actual) && isRecord(expected) && !Array.isArray(actual) && !Array.isArray(expected)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    const pathOf = (key: string): string => (path === '' ? key : `${path}.${key}`)
    return keys
      .map((key) =>
        key in actual && key in expected ? firstDifference(actual[key], expected[key], pathOf(key)) : pathOf(key)
      )
      .find((difference) => difference !== undefined)
  }
  return path === '' ? 'the job' : path
}

// ci.yml's job publish against the template: equal but for its pinned actions' SHAs, each a full commit SHA.
const publishJobFindings = (job: unknown, template: unknown): string[] => {
  const at = `${PUBLISH_WORKFLOW}: job ${PUBLISH_JOB}:`
  if (template === undefined) {
    return [`${at} ${PUBLISH_JOB_TEMPLATE} is missing, so the job cannot be compared [release-guard/publish-job]`]
  }
  const steps = isRecord(job) && Array.isArray(job.steps) ? (job.steps as unknown[]) : []
  const unpinned = steps
    .map((step) => pinnedUse(isRecord(step) ? step.uses : undefined))
    .filter((pinned) => pinned !== undefined && !FULL_SHA.test(pinned.ref))
    .map(
      (pinned) =>
        `${at} ${pinned?.action ?? ''}@${pinned?.ref ?? ''} is not a full commit SHA [release-guard/publish-job]`
    )
  const difference = firstDifference(withoutShas(job), withoutShas(template), '')
  return [
    ...(difference === undefined
      ? []
      : [`${at} ${difference} differs from ${PUBLISH_JOB_TEMPLATE} [release-guard/publish-job]`]),
    ...unpinned,
  ]
}

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split('\n').length

// The lines of ci.yml's job publish, where the publishing text is the job's own.
const publishJobLines = (file: string, text: string): ReadonlySet<number> => {
  const node = file === PUBLISH_WORKFLOW ? parseDocument(text).getIn(['jobs', PUBLISH_JOB], true) : undefined
  if (!isNode(node) || node.range === undefined || node.range === null) {
    return new Set()
  }
  const [start, , end] = node.range
  const first = lineOf(text, start)
  return new Set(Array.from({ length: lineOf(text, end) - first + 1 }, (_unused, index) => first + index))
}

const textFindings = (file: string, text: string, publishLines: ReadonlySet<number>): string[] =>
  text.split('\n').flatMap((line, index) => {
    const at = `${file}:${String(index + 1)}:`
    const forbidden = FORBIDDEN_TEXT.filter(
      (phrase) => line.includes(phrase) && !(PUBLISH_TEXT.has(phrase) && publishLines.has(index + 1))
    )
    const secrets = [...line.matchAll(SECRET)]
      .map((match) => match.groups?.name ?? '')
      .filter((name) => name !== ALLOWED_SECRET)
    return [
      ...forbidden.map((phrase) => `${at} ${phrase} [release-guard/no-publish-text]`),
      ...secrets.map((name) => `${at} secrets.${name} [release-guard/no-stored-secret]`),
    ]
  })

const workflowFindings = (file: string, text: string, template: unknown): string[] => {
  const parsed: unknown = parse(text)
  const workflow = isRecord(parsed) ? parsed : {}
  const jobs = isRecord(workflow.jobs) ? workflow.jobs : {}
  return [
    ...('permissions' in workflow ? [] : [`${file}: no top-level permissions [release-guard/workflow-permissions]`]),
    ...Object.entries(jobs).flatMap(([id, job]) =>
      file === PUBLISH_WORKFLOW && id === PUBLISH_JOB
        ? publishJobFindings(job, template)
        : jobFindings(file, workflow, id, job)
    ),
    ...textFindings(file, text, publishJobLines(file, text)),
  ]
}

const manifestFinding = (file: string, text: string): string[] => {
  const parsed: unknown = JSON.parse(text)
  return isRecord(parsed) && parsed.private === true
    ? []
    : [`${file}: not "private": true; only the staged copies reach npm [release-guard/private-manifest]`]
}

const NPM_PLUGIN = '@semantic-release/npm'

// semantic-release's configuration, exactly the one release-config.ts holds; an npm plugin is named on its own, since
// it would publish from semantic-release's dependency tree.
const releaseConfigFindings = async (root: string): Promise<string[]> => {
  let text: string
  try {
    text = await readFile(join(root, RELEASE_CONFIG_FILE), 'utf8')
  } catch {
    return [`${RELEASE_CONFIG_FILE}: missing [release-guard/release-config]`]
  }
  if (text.includes(NPM_PLUGIN)) {
    return [
      `${RELEASE_CONFIG_FILE}: names ${NPM_PLUGIN}; publishing is the publish job's [release-guard/release-config]`,
    ]
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return [`${RELEASE_CONFIG_FILE}: not valid JSON [release-guard/release-config]`]
  }
  return isDeepStrictEqual(parsed, RELEASE_CONFIG)
    ? []
    : [`${RELEASE_CONFIG_FILE}: not exactly the release configuration [release-guard/release-config]`]
}

// Every workflow right and manifest the release guard refuses: no OIDC token, no contents write, no npm environment
// or publishing text, no stored secret, outside ci.yml's job publish, which must equal its template; every workspace
// manifest private; and semantic-release configured exactly.
export const releaseFindings = async (root: string): Promise<string[]> => {
  const files = await trackedFiles(root, ['.github/workflows', 'packages', 'apps'])
  const read = async (file: string): Promise<string> => readFile(join(root, file), 'utf8')
  const template: unknown = files.includes(PUBLISH_JOB_TEMPLATE) ? parse(await read(PUBLISH_JOB_TEMPLATE)) : undefined
  const workflows = await Promise.all(
    files.filter((file) => WORKFLOW.test(file)).map(async (file) => workflowFindings(file, await read(file), template))
  )
  const manifests = await Promise.all(
    files.filter((file) => MANIFEST.test(file)).map(async (file) => manifestFinding(file, await read(file)))
  )
  return [...workflows.flat(), ...manifests.flat(), ...(await releaseConfigFindings(root))]
}
