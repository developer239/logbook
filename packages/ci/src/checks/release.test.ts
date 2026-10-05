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

const findings = async (files: Readonly<Record<string, string>>): Promise<string[]> =>
  releaseFindings(await workspaces.create({ 'apps/example/package.json': PRIVATE, ...files }))

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
})
