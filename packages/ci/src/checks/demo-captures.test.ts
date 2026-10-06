import { afterEach, describe, expect, it } from 'vitest'
import { gitWorkspaces } from '../testing/git-workspace.js'
import { demoCaptureArguments } from './demo-captures.js'

const MANIFEST = 'apps/docs/committed-captures.json'
const SHA256 = 'a'.repeat(64)

const demoEntry = (name: string, size: string, seed: number): Record<string, unknown> => ({
  file: `apps/docs/src/public/committed/${name}.png`,
  sha256: SHA256,
  source: 'demo',
  build: { size, seed, labels: 'none', anchor: '2026-03-02T12:00:00Z' },
  page: '/conversations',
  text: `apps/docs/src/public/committed/${name}.txt`,
  textSha256: SHA256,
})

const OWNER_ENTRY = {
  file: 'apps/docs/src/public/committed/owner-dashboard.png',
  sha256: SHA256,
  source: 'owner',
  screen: 'dashboard',
  covered: [],
  approval: { by: 'owner', on: '2026-03-02', pullRequest: 1 },
}

const workspaces = gitWorkspaces()

afterEach(async () => {
  await workspaces.removeAll()
})

describe('demoCaptureArguments', () => {
  it('gives one line per demo entry, in the manifest order, with its size and seed', async () => {
    // Arrange
    const root = await workspaces.create({
      [MANIFEST]: JSON.stringify({
        captures: [demoEntry('rich-steps', 'rich', 7), OWNER_ENTRY, demoEntry('small-tokens', 'small', 42)],
      }),
    })

    // Act
    const lines = await demoCaptureArguments(root)

    // Assert
    expect(lines).toStrictEqual([
      'apps/docs/src/public/committed/rich-steps.txt --size rich --seed 7',
      'apps/docs/src/public/committed/small-tokens.txt --size small --seed 42',
    ])
  })

  it('gives nothing for a manifest with no demo entry', async () => {
    // Arrange
    const root = await workspaces.create({ [MANIFEST]: JSON.stringify({ captures: [OWNER_ENTRY] }) })

    // Act
    const lines = await demoCaptureArguments(root)

    // Assert
    expect(lines).toStrictEqual([])
  })

  it('names the manifest when it is not valid JSON', async () => {
    // Arrange
    const root = await workspaces.create({ [MANIFEST]: '{ "captures": [' })

    // Act
    const lines = await demoCaptureArguments(root)

    // Assert
    expect(lines).toBe('apps/docs/committed-captures.json: not valid JSON')
  })

  it('names the demo entries that lack what the scan takes', async () => {
    // Arrange
    const root = await workspaces.create({
      [MANIFEST]: JSON.stringify({
        captures: [OWNER_ENTRY, { ...demoEntry('small-tokens', 'small', 42), text: undefined }],
      }),
    })

    // Act
    const lines = await demoCaptureArguments(root)

    // Assert
    expect(lines).toBe('apps/docs/committed-captures.json: entries 2 lack text, build.size or build.seed')
  })
})
