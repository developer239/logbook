import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
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

const textFindings = (file: string, text: string): string[] =>
  text.split('\n').flatMap((line, index) => {
    const at = `${file}:${String(index + 1)}:`
    const forbidden = FORBIDDEN_TEXT.filter((phrase) => line.includes(phrase))
    const secrets = [...line.matchAll(SECRET)]
      .map((match) => match.groups?.name ?? '')
      .filter((name) => name !== ALLOWED_SECRET)
    return [
      ...forbidden.map((phrase) => `${at} ${phrase} [release-guard/no-publish-text]`),
      ...secrets.map((name) => `${at} secrets.${name} [release-guard/no-stored-secret]`),
    ]
  })

const workflowFindings = (file: string, text: string): string[] => {
  const parsed: unknown = parse(text)
  const workflow = isRecord(parsed) ? parsed : {}
  const jobs = isRecord(workflow.jobs) ? workflow.jobs : {}
  return [
    ...('permissions' in workflow ? [] : [`${file}: no top-level permissions [release-guard/workflow-permissions]`]),
    ...Object.entries(jobs).flatMap(([id, job]) => jobFindings(file, workflow, id, job)),
    ...textFindings(file, text),
  ]
}

const manifestFinding = (file: string, text: string): string[] => {
  const parsed: unknown = JSON.parse(text)
  return isRecord(parsed) && parsed.private === true
    ? []
    : [`${file}: not "private": true; only the staged copies reach npm [release-guard/private-manifest]`]
}

// Every workflow right and manifest the release guard refuses: no OIDC token, no contents write, no npm environment
// or publishing text, no stored secret, and every workspace manifest private.
export const releaseFindings = async (root: string): Promise<string[]> => {
  const files = await trackedFiles(root, ['.github/workflows', 'packages', 'apps'])
  const read = async (file: string): Promise<string> => readFile(join(root, file), 'utf8')
  const workflows = await Promise.all(
    files.filter((file) => WORKFLOW.test(file)).map(async (file) => workflowFindings(file, await read(file)))
  )
  const manifests = await Promise.all(
    files.filter((file) => MANIFEST.test(file)).map(async (file) => manifestFinding(file, await read(file)))
  )
  return [...workflows.flat(), ...manifests.flat()]
}
