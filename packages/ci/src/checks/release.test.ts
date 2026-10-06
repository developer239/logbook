import { afterEach, describe, expect, it } from 'vitest'
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

// The guard's findings on a workspace with a private manifest and the exact release configuration, with these files
// planted over it and those whose value is null removed.
const findings = async (files: Readonly<Record<string, string | null>>): Promise<string[]> => {
  const planted = {
    'apps/example/package.json': PRIVATE,
    '.releaserc.json': JSON.stringify(RELEASE_CONFIG, null, 2),
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
})
