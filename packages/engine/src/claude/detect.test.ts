import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeClaude, type IFakeClaudeScenario } from '../testing/index.js'
import { detectClaude } from './detect.js'

const CANARY = { name: 'LOGBOOK_TEST_CANARY', value: 'canary-7f3a' }
const INVENTED_KEY = 'sk-ant-invented-0000'

describe('detectClaude', () => {
  let directory = ''
  let fakeDirectory = ''

  // The fake alone on the PATH, so no real Claude Code on the machine can answer.
  const withFake = async (scenario: IFakeClaudeScenario = {}): ReturnType<typeof installFakeClaude> => {
    const fake = await installFakeClaude(fakeDirectory, { canary: CANARY, ...scenario })
    vi.stubEnv('PATH', fakeDirectory)
    return fake
  }

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-detect-')))
    fakeDirectory = join(directory, 'bin')
    await mkdir(fakeDirectory)
    vi.stubEnv('CLAUDE_BIN', '')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv(CANARY.name, CANARY.value)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  })

  it.each([
    ['no claude on the PATH', '', { kind: 'not-found', variable: null }],
    ['a relative CLAUDE_BIN', 'bin/claude', { kind: 'not-found', variable: 'CLAUDE_BIN' }],
    [
      'a CLAUDE_BIN naming a missing file',
      '/home/example/missing/claude',
      { kind: 'not-found', variable: 'CLAUDE_BIN' },
    ],
  ])('fails as not found with %s', async (_case, claudeBin, missing) => {
    // Arrange
    vi.stubEnv('PATH', join(directory, 'empty'))
    vi.stubEnv('CLAUDE_BIN', claudeBin)

    // Act
    const detection = await detectClaude()

    // Assert
    expect(detection).toStrictEqual({ status: 'missing', missing })
  })

  it('fails as too old naming the version it found', async () => {
    // Arrange
    await withFake({ version: '2.0.10' })

    // Act
    const detection = await detectClaude()

    // Assert
    expect(detection).toStrictEqual({
      status: 'missing',
      missing: { kind: 'too-old', version: '2.0.10', minimum: '2.1.286' },
    })
  })

  it('fails as not signed in when the login status says signed out', async () => {
    // Arrange
    await withFake({ auth: { loggedIn: false } })

    // Act
    const detection = await detectClaude()

    // Assert
    expect(detection).toStrictEqual({ status: 'missing', missing: { kind: 'not-signed-in' } })
  })

  it.each([
    ['a subscription on 2.1.286', {}, { version: '2.1.286', authMethod: 'claude.ai', apiProvider: 'firstParty' }],
    [
      'another auth method on a newer version',
      { version: '2.2.0', auth: { authMethod: 'console', apiProvider: 'bedrock' } },
      { version: '2.2.0', authMethod: 'console', apiProvider: 'bedrock' },
    ],
  ])('is ready with %s, reporting the fields', async (_case, scenario, fields) => {
    // Arrange
    const fake = await withFake(scenario)

    // Act
    const detection = await detectClaude()

    // Assert
    expect(detection).toStrictEqual({ status: 'ready', binary: fake.path, ...fields, hasApiKey: false })
  })

  it('takes CLAUDE_BIN when it names an executable file by its absolute path', async () => {
    // Arrange
    const fake = await withFake()
    vi.stubEnv('PATH', join(directory, 'empty'))
    vi.stubEnv('CLAUDE_BIN', fake.path)

    // Act
    const detection = await detectClaude()

    // Assert
    expect(detection).toMatchObject({ status: 'ready', binary: fake.path })
  })

  it('reports an API key as set and passes it on, its value nowhere', async () => {
    // Arrange
    const fake = await withFake()
    vi.stubEnv('ANTHROPIC_API_KEY', INVENTED_KEY)

    // Act
    const detection = await detectClaude()

    // Assert
    const records = await fake.readRecords()
    expect({
      hasApiKey: 'hasApiKey' in detection && detection.hasApiKey,
      isInResult: JSON.stringify(detection).includes(INVENTED_KEY),
      fake: records.map(({ hasApiKey, isApiKeyInStdin }) => ({ hasApiKey, isApiKeyInStdin })),
      isInRecords: JSON.stringify(records).includes(INVENTED_KEY),
    }).toStrictEqual({
      hasApiKey: true,
      isInResult: false,
      fake: [
        { hasApiKey: true, isApiKeyInStdin: false },
        { hasApiKey: true, isApiKeyInStdin: false },
      ],
      isInRecords: false,
    })
  })

  it('runs both detection calls with the two variables in a fresh empty directory that is gone afterwards', async () => {
    // Arrange
    const fake = await withFake()

    // Act
    await detectClaude()

    // Assert
    const records = await fake.readRecords()
    expect(
      records.map((record) => ({
        argv: record.argv,
        model: record.model,
        maxThinkingTokens: record.maxThinkingTokens,
        disableNonessentialTraffic: record.disableNonessentialTraffic,
        isFresh: record.cwdExisted && record.cwdWasEmpty && record.cwd.includes('logbook-label-'),
        cwdStillExists: record.cwdStillExists,
        canary: record.canary,
      }))
    ).toStrictEqual(
      [['--version'], ['auth', 'status', '--json']].map((argv) => ({
        argv,
        model: null,
        maxThinkingTokens: '0',
        disableNonessentialTraffic: '1',
        isFresh: true,
        cwdStillExists: false,
        canary: { isArrived: true, isInStdin: false },
      }))
    )
  })
})
