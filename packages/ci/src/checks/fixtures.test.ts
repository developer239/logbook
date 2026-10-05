import { afterEach, describe, expect, it } from 'vitest'
import { gitWorkspaces } from '../testing/git-workspace.js'
import { fixtureFindings } from './fixtures.js'

const FIXTURE = 'packages/adapter-example/fixtures/1.0/session.jsonl'
const workspaces = gitWorkspaces()

afterEach(async () => {
  await workspaces.removeAll()
})

describe('the fixture conventions check', () => {
  it.each([
    '/home/example/work/shop',
    'ses_example01',
    'ses_demo3',
    '5f0c2a1e-0000-4000-8000-000000000001',
    'de30da7a-0000-4000-8000-000000000001',
    'agent-example01',
    'agent-switched',
  ])('passes %s', async (value) => {
    // Arrange
    const root = await workspaces.create({ [FIXTURE]: `{"value": "${value}"}\n` })

    // Act
    const found = await fixtureFindings(root)

    // Assert
    expect(found).toStrictEqual([])
  })

  it.each([
    ['/Users/alex/work', 'fixture-home'],
    ['/home/alex/work', 'fixture-home'],
    ['ses_k3j9x2', 'fixture-id'],
    ['9b1e2c3d-0000-4000-8000-000000000001', 'fixture-uuid'],
    ['agent-a1f0009', 'fixture-agent'],
  ])('refuses %s, naming the file, the line and the rule %s', async (value, rule) => {
    // Arrange
    const root = await workspaces.create({ [FIXTURE]: `{"first": "line"}\n{"cwd": "${value}"}\n` })

    // Act
    const found = await fixtureFindings(root)

    // Assert
    expect(found).toStrictEqual([`${FIXTURE}:2: ${value} is not an invented value [${rule}]`])
  })

  it('reads only adapter fixtures', async () => {
    // Arrange
    const root = await workspaces.create({ 'packages/core/src/example.ts': "const home = '/Users/alex/work'\n" })

    // Act
    const found = await fixtureFindings(root)

    // Assert
    expect(found).toStrictEqual([])
  })
})
