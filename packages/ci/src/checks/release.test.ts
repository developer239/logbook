import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { gitWorkspaces } from '../testing/git-workspace.js'
import { releaseFindings } from './release.js'

const WORKFLOW = '.github/workflows/example.yml'
const PRIVATE = JSON.stringify({ name: '@log-book/example', private: true })
const workspaces = gitWorkspaces()

// A workflow with top-level permissions and one job, `build`, holding the lines given.
const workflow = ({ top = 'permissions:\n  contents: read', job = [] as string[] } = {}): string =>
  [
    'name: Example',
    'on: push',
    top,
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    ...job.map((line) => `    ${line}`),
    '    steps:',
    '      - run: echo example',
    '',
  ].join('\n')

// An expression reading a stored secret.
const secret = (name: string): string => ['$', '{{ secrets.', name, ' }}'].join('')

// semantic-release's configuration, exactly as the guard holds it.
const RELEASE_CONFIG = {
  branches: [{ name: 'main', channel: 'next' }],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    ['@semantic-release/github', { successComment: false, failComment: false, releasedLabels: false }],
  ],
}

// The publish job's template, as the repository holds it.
const TEMPLATE_FILE = 'packages/ci/src/rules/publish-job.yaml'
const TEMPLATE_TEXT = readFileSync(new URL('../rules/publish-job.yaml', import.meta.url), 'utf8')
const CI = '.github/workflows/ci.yml'
const PUBLISH_STEP = 4

interface IStep {
  uses?: string
  run?: string
}

// A fresh copy of the template's job, to change before planting it.
const publishJob = (): { env: Record<string, string>; steps: IStep[] } & Record<string, unknown> =>
  parse(TEMPLATE_TEXT) as { env: Record<string, string>; steps: IStep[] } & Record<string, unknown>

// ci.yml with top-level permissions, the publish job given and any other jobs.
const ciWorkflow = (publish: unknown, jobs: Record<string, unknown> = {}): string =>
  stringify({ name: 'CI', on: 'push', permissions: { contents: 'read' }, jobs: { ...jobs, publish } })

// The 1-based line of the first line of a text holding this phrase.
const lineHolding = (text: string, phrase: string): number =>
  text.split('\n').findIndex((line) => line.includes(phrase)) + 1

// The guard's findings on a workspace with a private manifest, the exact release configuration and the publish job's
// template, with these files planted over it and those whose value is null removed.
const findings = async (files: Readonly<Record<string, string | null>>): Promise<string[]> => {
  const planted = {
    'apps/example/package.json': PRIVATE,
    '.releaserc.json': JSON.stringify(RELEASE_CONFIG, null, 2),
    [TEMPLATE_FILE]: TEMPLATE_TEXT,
    ...files,
  }
  return releaseFindings(
    await workspaces.create(
      Object.fromEntries(
        Object.entries(planted).filter((pair): pair is [string, string] => typeof pair[1] === 'string')
      )
    )
  )
}

afterEach(async () => {
  await workspaces.removeAll()
})

describe('the release guard', () => {
  it("passes contents: write in ci.yml's job release, and refuses it in any other job and workflow", async () => {
    // Arrange
    const writes = { 'runs-on': 'ubuntu-latest', 'permissions': { contents: 'write' }, 'steps': [{ run: 'echo x' }] }

    // Act
    const found = await findings({
      [CI]: ciWorkflow(publishJob(), { release: writes, build: writes }),
      [WORKFLOW]: stringify({
        name: 'Example',
        on: 'push',
        permissions: { contents: 'read' },
        jobs: { release: writes },
      }),
    })

    // Assert
    expect(found).toStrictEqual([
      `${CI}: job build: contents: write [release-guard/no-contents-write]`,
      `${WORKFLOW}: job release: contents: write [release-guard/no-contents-write]`,
    ])
  })

  it("refuses an OIDC token and an npm environment in ci.yml's job release", async () => {
    // Act
    const found = await findings({
      [CI]: ciWorkflow(publishJob(), {
        release: {
          'runs-on': 'ubuntu-latest',
          'environment': 'npm-next',
          'permissions': { 'contents': 'write', 'id-token': 'write' },
          'steps': [{ run: 'echo x' }],
        },
      }),
    })

    // Assert
    expect(found).toStrictEqual([
      `${CI}: job release: id-token: write [release-guard/no-id-token]`,
      `${CI}: job release: environment npm-next [release-guard/no-npm-environment]`,
    ])
  })

  it('passes a workflow that reads only and a private manifest', async () => {
    // Act
    const found = await findings({ [WORKFLOW]: workflow() })

    // Assert
    expect(found).toStrictEqual([])
  })

  it('refuses write-all on a job as both an OIDC token and a contents write', async () => {
    // Act
    const found = await findings({ [WORKFLOW]: workflow({ job: ['permissions: write-all'] }) })

    // Assert
    expect(found).toStrictEqual([
      `${WORKFLOW}: job build: id-token: write [release-guard/no-id-token]`,
      `${WORKFLOW}: job build: contents: write [release-guard/no-contents-write]`,
    ])
  })

  it('refuses an OIDC token at the top for a job without its own permissions', async () => {
    // Act
    const found = await findings({ [WORKFLOW]: workflow({ top: 'permissions:\n  id-token: write' }) })

    // Assert
    expect(found).toStrictEqual([`${WORKFLOW}: job build: id-token: write [release-guard/no-id-token]`])
  })

  it('passes an OIDC token at the top for a job whose own permissions read contents only', async () => {
    // Act
    const found = await findings({
      [WORKFLOW]: workflow({ top: 'permissions:\n  id-token: write', job: ['permissions:', '  contents: read'] }),
    })

    // Assert
    expect(found).toStrictEqual([])
  })

  it.each([
    ['as a name', ['environment: npm-next'], 'npm-next'],
    ['as name:', ['environment:', '  name: npm-latest'], 'npm-latest'],
  ])('refuses an npm environment written %s', async (_case, job, environment) => {
    // Act
    const found = await findings({ [WORKFLOW]: workflow({ job }) })

    // Assert
    expect(found).toStrictEqual([
      `${WORKFLOW}: job build: environment ${environment} [release-guard/no-npm-environment]`,
    ])
  })

  it.each([
    'npm publish',
    'npm-cli.js',
    'npm dist-tag',
    '--tag latest',
    'NPM_TOKEN',
    'NODE_AUTH_TOKEN',
    'pull_request_target',
  ])('refuses %j in a run script and in a comment', async (phrase) => {
    // Arrange
    const text = workflow().replace('echo example', `echo ${phrase}`).concat(`# ${phrase}\n`)

    // Act
    const found = await findings({ [WORKFLOW]: text })

    // Assert
    expect(found).toStrictEqual([
      `${WORKFLOW}:9: ${phrase} [release-guard/no-publish-text]`,
      `${WORKFLOW}:10: ${phrase} [release-guard/no-publish-text]`,
    ])
  })

  it('passes secrets.GITHUB_TOKEN and refuses any other stored secret', async () => {
    // Arrange
    const text = workflow({ job: ['env:', `  FIRST: ${secret('GITHUB_TOKEN')}`, `  SECOND: ${secret('EXAMPLE')}`] })

    // Act
    const found = await findings({ [WORKFLOW]: text })

    // Assert
    expect(found).toStrictEqual([`${WORKFLOW}:10: secrets.EXAMPLE [release-guard/no-stored-secret]`])
  })

  it('refuses a workflow without top-level permissions', async () => {
    // Act
    const found = await findings({ [WORKFLOW]: workflow({ top: '' }) })

    // Assert
    expect(found).toStrictEqual([`${WORKFLOW}: no top-level permissions [release-guard/workflow-permissions]`])
  })

  it.each([
    ['without private', { name: '@log-book/example' }],
    ['with private false', { name: '@log-book/example', private: false }],
  ])('refuses a workspace manifest %s', async (_case, manifest) => {
    // Act
    const found = await findings({ 'apps/example/package.json': JSON.stringify(manifest) })

    // Assert
    expect(found).toStrictEqual([
      'apps/example/package.json: not "private": true; only the staged copies reach npm ' +
        '[release-guard/private-manifest]',
    ])
  })

  it.each([
    [
      'with @semantic-release/npm added',
      JSON.stringify({ ...RELEASE_CONFIG, plugins: [...RELEASE_CONFIG.plugins, '@semantic-release/npm'] }),
      ".releaserc.json: names @semantic-release/npm; publishing is the publish job's [release-guard/release-config]",
    ],
    [
      'with the channel changed',
      JSON.stringify({ ...RELEASE_CONFIG, branches: [{ name: 'main', channel: 'latest' }] }),
      '.releaserc.json: not exactly the release configuration [release-guard/release-config]',
    ],
    ['missing', null, '.releaserc.json: missing [release-guard/release-config]'],
  ])('refuses a release configuration %s', async (_case, text, finding) => {
    // Act
    const found = await findings({ '.releaserc.json': text })

    // Assert
    expect(found).toStrictEqual([finding])
  })

  describe('the publish job', () => {
    it("passes ci.yml's job publish equal to the template", async () => {
      // Act
      const found = await findings({ [CI]: ciWorkflow(publishJob()) })

      // Assert
      expect(found).toStrictEqual([])
    })

    it('passes the job with its actions pinned to other full commit SHAs', async () => {
      // Arrange
      const job = publishJob()
      const [setupNode, downloadArtifact] = job.steps
      job.steps = [
        { ...setupNode, uses: `actions/setup-node@${'a'.repeat(40)}` },
        { ...downloadArtifact, uses: `actions/download-artifact@${'b'.repeat(40)}` },
        ...job.steps.slice(2),
      ]

      // Act
      const found = await findings({ [CI]: ciWorkflow(job) })

      // Assert
      expect(found).toStrictEqual([])
    })

    it.each([
      ['an extra step', (job: ReturnType<typeof publishJob>) => ({ ...job, steps: [...job.steps, { run: 'ls' }] })],
      [
        'actions/checkout added',
        (job: ReturnType<typeof publishJob>) => ({
          ...job,
          steps: [{ uses: `actions/checkout@${'c'.repeat(40)}` }, ...job.steps],
        }),
      ],
    ])('fails with %s', async (_case, change) => {
      // Act
      const found = await findings({ [CI]: ciWorkflow(change(publishJob())) })

      // Assert
      expect(found).toStrictEqual([
        `${CI}: job publish: steps differs from ${TEMPLATE_FILE} [release-guard/publish-job]`,
      ])
    })

    it.each([
      ['a version tag', 'v4'],
      ['a 7-character SHA', '8207627'],
    ])('fails with actions/setup-node pinned to %s', async (_case, ref) => {
      // Arrange
      const job = publishJob()
      job.steps = [{ ...job.steps[0], uses: `actions/setup-node@${ref}` }, ...job.steps.slice(1)]

      // Act
      const found = await findings({ [CI]: ciWorkflow(job) })

      // Assert
      expect(found).toStrictEqual([
        `${CI}: job publish: actions/setup-node@${ref} is not a full commit SHA [release-guard/publish-job]`,
      ])
    })

    it('fails with the npm integrity changed', async () => {
      // Arrange
      const job = publishJob()
      job.env = { ...job.env, NPM_INTEGRITY: `sha512-${'A'.repeat(86)}==` }

      // Act
      const found = await findings({ [CI]: ciWorkflow(job) })

      // Assert
      expect(found).toStrictEqual([
        `${CI}: job publish: env.NPM_INTEGRITY differs from ${TEMPLATE_FILE} [release-guard/publish-job]`,
      ])
    })

    it('fails with --tag latest', async () => {
      // Arrange
      const job = publishJob()
      job.steps = job.steps.map((step, index) =>
        index === PUBLISH_STEP ? { ...step, run: (step.run ?? '').replace('--tag next', '--tag latest') } : step
      )
      const text = ciWorkflow(job)

      // Act
      const found = await findings({ [CI]: text })

      // Assert
      expect(found).toStrictEqual([
        `${CI}: job publish: steps[${String(PUBLISH_STEP)}].run differs from ${TEMPLATE_FILE} [release-guard/publish-job]`,
        `${CI}:${String(lineHolding(text, '--tag latest'))}: --tag latest [release-guard/no-publish-text]`,
      ])
    })

    it('fails on npm publish in another job', async () => {
      // Arrange
      const text = ciWorkflow(publishJob(), {
        build: { 'runs-on': 'ubuntu-latest', 'steps': [{ run: 'npm publish ./package' }] },
      })

      // Act
      const found = await findings({ [CI]: text })

      // Assert
      expect(found).toStrictEqual([
        `${CI}:${String(lineHolding(text, 'npm publish ./package'))}: npm publish [release-guard/no-publish-text]`,
      ])
    })

    it('fails on id-token: write and environment: npm-next on another job', async () => {
      // Act
      const found = await findings({
        [CI]: ciWorkflow(publishJob(), {
          build: {
            'runs-on': 'ubuntu-latest',
            'environment': 'npm-next',
            'permissions': { 'id-token': 'write' },
            'steps': [{ run: 'ls' }],
          },
        }),
      })

      // Assert
      expect(found).toStrictEqual([
        `${CI}: job build: id-token: write [release-guard/no-id-token]`,
        `${CI}: job build: environment npm-next [release-guard/no-npm-environment]`,
      ])
    })
  })
})
