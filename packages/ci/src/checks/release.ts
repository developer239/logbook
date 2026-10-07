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
const CI_WORKFLOW = '.github/workflows/ci.yml'
const PROMOTE_WORKFLOW = '.github/workflows/promote.yml'
const DOCS_WORKFLOW = '.github/workflows/docs.yml'

// A job that may hold an npm token: equal to its template but for the commit SHAs of its pinned actions, which must be
// full SHAs. Within its lines alone, the workflow's text may hold these phrases.
interface IGuardedJob {
  workflow: string
  job: string
  template: string
  actions: readonly string[]
  text: ReadonlySet<string>
  rule: string
}

// ci.yml's job publish, which publishes to next; promote.yml's job move, which moves latest and cannot publish; and
// docs.yml's job deploy, which deploys the site with an OIDC token no npm trusted publisher accepts.
const GUARDED_JOBS: readonly IGuardedJob[] = [
  {
    workflow: CI_WORKFLOW,
    job: 'publish',
    template: 'packages/ci/src/rules/publish-job.yaml',
    actions: ['actions/setup-node', 'actions/download-artifact'],
    text: new Set(['npm publish', 'npm-cli.js']),
    rule: 'release-guard/publish-job',
  },
  {
    workflow: PROMOTE_WORKFLOW,
    job: 'move',
    template: 'packages/ci/src/rules/promote-job.yaml',
    actions: ['actions/setup-node'],
    text: new Set(['npm dist-tag', 'npm-cli.js']),
    rule: 'release-guard/move-job',
  },
  {
    workflow: DOCS_WORKFLOW,
    job: 'deploy',
    template: 'packages/ci/src/rules/docs-deploy-job.yaml',
    actions: ['actions/deploy-pages'],
    text: new Set(),
    rule: 'release-guard/docs-deploy-job',
  },
]
// The jobs that may write contents: ci.yml's job release, which pushes the tag and writes the GitHub release, and
// promote.yml's job finish, which marks the promoted release latest.
const CONTENTS_WRITERS = [`${CI_WORKFLOW}#release`, `${PROMOTE_WORKFLOW}#finish`]
// The triggers each release workflow may have: promote.yml a dispatch only; docs.yml a dispatch and the completion of
// promote's runs, the only workflow its workflow_run may name.
const ALLOWED_TRIGGERS: ReadonlyMap<string, readonly string[]> = new Map([
  [PROMOTE_WORKFLOW, ['workflow_dispatch']],
  [DOCS_WORKFLOW, ['workflow_run', 'workflow_dispatch']],
])
const DOCS_SOURCE = 'promote'
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
  const canWriteContents = CONTENTS_WRITERS.includes(`${file}#${id}`)
  return [
    ...(grants(permissions, 'id-token') ? [`${at} id-token: write [release-guard/no-id-token]`] : []),
    ...(grants(permissions, 'contents') && !canWriteContents
      ? [`${at} contents: write [release-guard/no-contents-write]`]
      : []),
    ...(typeof environment === 'string' && NPM_ENVIRONMENTS.has(environment)
      ? [`${at} environment ${environment} [release-guard/no-npm-environment]`]
      : []),
  ]
}

// A step's `uses` of one of these pinned actions, split into the action and its ref; undefined for any other value.
const pinnedUse = (value: unknown, actions: readonly string[]): { action: string; ref: string } | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const [action = '', ref = ''] = value.split('@')
  return actions.includes(action) ? { action, ref } : undefined
}

// The job with the refs of its pinned actions replaced, so the template and the job compare without their SHAs.
const withoutShas = (value: unknown, actions: readonly string[]): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => withoutShas(item, actions))
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutShas(item, actions)]))
  }
  const pinned = pinnedUse(value, actions)
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

// A guarded job against its template: equal but for its pinned actions' SHAs, each a full commit SHA.
const guardedJobFindings = (guarded: IGuardedJob, job: unknown, template: unknown): string[] => {
  const at = `${guarded.workflow}: job ${guarded.job}:`
  if (template === undefined) {
    return [`${at} ${guarded.template} is missing, so the job cannot be compared [${guarded.rule}]`]
  }
  const steps = isRecord(job) && Array.isArray(job.steps) ? (job.steps as unknown[]) : []
  const unpinned = steps
    .map((step) => pinnedUse(isRecord(step) ? step.uses : undefined, guarded.actions))
    .filter((pinned) => pinned !== undefined && !FULL_SHA.test(pinned.ref))
    .map((pinned) => `${at} ${pinned?.action ?? ''}@${pinned?.ref ?? ''} is not a full commit SHA [${guarded.rule}]`)
  const difference = firstDifference(withoutShas(job, guarded.actions), withoutShas(template, guarded.actions), '')
  return [
    ...(difference === undefined ? [] : [`${at} ${difference} differs from ${guarded.template} [${guarded.rule}]`]),
    ...unpinned,
  ]
}

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split('\n').length

// The phrases each line of the workflow's guarded jobs may hold, by line number.
const guardedLines = (file: string, text: string): ReadonlyMap<number, ReadonlySet<string>> => {
  const document = parseDocument(text)
  return new Map(
    GUARDED_JOBS.filter((guarded) => guarded.workflow === file).flatMap((guarded) => {
      const node = document.getIn(['jobs', guarded.job], true)
      if (!isNode(node) || node.range === undefined || node.range === null) {
        return []
      }
      const [start, , end] = node.range
      const first = lineOf(text, start)
      return Array.from({ length: lineOf(text, end) - first + 1 }, (_unused, index): [number, ReadonlySet<string>] => [
        first + index,
        guarded.text,
      ])
    })
  )
}

const textFindings = (file: string, text: string, allowed: ReadonlyMap<number, ReadonlySet<string>>): string[] =>
  text.split('\n').flatMap((line, index) => {
    const at = `${file}:${String(index + 1)}:`
    const forbidden = FORBIDDEN_TEXT.filter(
      (phrase) => line.includes(phrase) && allowed.get(index + 1)?.has(phrase) !== true
    )
    const secrets = [...line.matchAll(SECRET)]
      .map((match) => match.groups?.name ?? '')
      .filter((name) => name !== ALLOWED_SECRET)
    return [
      ...forbidden.map((phrase) => `${at} ${phrase} [release-guard/no-publish-text]`),
      ...secrets.map((name) => `${at} secrets.${name} [release-guard/no-stored-secret]`),
    ]
  })

// A workflow_run of any workflow but promote.
const runSourceFindings = (file: string, on: Record<string, unknown>): string[] => {
  const run = on.workflow_run
  const sources: unknown = isRecord(run) ? run.workflows : undefined
  return 'workflow_run' in on && !isDeepStrictEqual(sources, [DOCS_SOURCE])
    ? [
        `${file}: workflow_run of ${JSON.stringify(sources ?? null)}, not of ${DOCS_SOURCE} alone [release-guard/workflow-trigger]`,
      ]
    : []
}

// A release workflow's triggers beyond those it may have.
const triggerFindings = (file: string, workflow: Record<string, unknown>): string[] => {
  const allowed = ALLOWED_TRIGGERS.get(file)
  if (allowed === undefined) {
    return []
  }
  const on = isRecord(workflow.on) ? workflow.on : {}
  const triggers = typeof workflow.on === 'string' ? [workflow.on] : Object.keys(on)
  const others = triggers.filter((trigger) => !allowed.includes(trigger))
  return [
    ...(others.length > 0 || triggers.length === 0
      ? [
          `${file}: triggered by ${others.join(', ') || 'nothing'}, not only ${allowed.join(' and ')} ` +
            '[release-guard/workflow-trigger]',
        ]
      : []),
    ...runSourceFindings(file, on),
  ]
}

const workflowFindings = (file: string, text: string, templates: ReadonlyMap<string, unknown>): string[] => {
  const parsed: unknown = parse(text)
  const workflow = isRecord(parsed) ? parsed : {}
  const jobs = isRecord(workflow.jobs) ? workflow.jobs : {}
  return [
    ...('permissions' in workflow ? [] : [`${file}: no top-level permissions [release-guard/workflow-permissions]`]),
    ...triggerFindings(file, workflow),
    ...Object.entries(jobs).flatMap(([id, job]) => {
      const guarded = GUARDED_JOBS.find((candidate) => candidate.workflow === file && candidate.job === id)
      return guarded === undefined
        ? jobFindings(file, workflow, id, job)
        : guardedJobFindings(guarded, job, templates.get(guarded.template))
    }),
    ...textFindings(file, text, guardedLines(file, text)),
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

// Every workflow right and manifest the release guard refuses: no OIDC token, no npm environment or publishing text, no
// stored secret, outside ci.yml's job publish, promote.yml's job move and docs.yml's job deploy, which must equal their
// templates; no contents write but in ci.yml's job release and promote.yml's job finish; promote.yml started only by a
// dispatch, and docs.yml by a dispatch or promote's completion; every workspace manifest private; and semantic-release
// configured exactly.
export const releaseFindings = async (root: string): Promise<string[]> => {
  const files = await trackedFiles(root, ['.github/workflows', 'packages', 'apps'])
  const read = async (file: string): Promise<string> => readFile(join(root, file), 'utf8')
  const templates = new Map(
    await Promise.all(
      GUARDED_JOBS.filter((guarded) => files.includes(guarded.template)).map(
        async (guarded): Promise<[string, unknown]> => [guarded.template, parse(await read(guarded.template))]
      )
    )
  )
  const workflows = await Promise.all(
    files.filter((file) => WORKFLOW.test(file)).map(async (file) => workflowFindings(file, await read(file), templates))
  )
  const manifests = await Promise.all(
    files.filter((file) => MANIFEST.test(file)).map(async (file) => manifestFinding(file, await read(file)))
  )
  return [...workflows.flat(), ...manifests.flat(), ...(await releaseConfigFindings(root))]
}
