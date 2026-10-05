import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installFakeClaude,
  type FakeClaudeEnvelope,
  type IFakeClaude,
  type IFakeClaudeScenario,
} from '../testing/index.js'
import { runLabelBatch, type ILabelBatchCall } from './batch-call.js'

const MODEL = 'claude-haiku-4-5'
const SYSTEM_PROMPT = 'Answer each tagged item on its own line, starting with its tag.'
const PROMPT_TEXT = 'keep the saved cart after sign-in'
const PROMPT = `Label these.\n\n### #1\n${PROMPT_TEXT}\n`
const CANARY = { name: 'LOGBOOK_TEST_CANARY', value: 'canary-51c2' }

describe('runLabelBatch', () => {
  let directory = ''
  let runDirectory = ''

  const install = async (scenario: IFakeClaudeScenario = {}): Promise<IFakeClaude> => {
    const bin = join(directory, 'bin')
    await mkdir(bin, { recursive: true })
    return installFakeClaude(bin, {
      canary: CANARY,
      answers: [{ systemPrompt: SYSTEM_PROMPT, answer: 'task' }],
      ...scenario,
    })
  }

  const call = (fake: IFakeClaude, fields: Partial<ILabelBatchCall> = {}): ReturnType<typeof runLabelBatch> =>
    runLabelBatch({
      binary: fake.path,
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      prompt: PROMPT,
      cwd: runDirectory,
      signal: new AbortController().signal,
      ...fields,
    })

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-batch-')))
    runDirectory = join(directory, 'run')
    await mkdir(runDirectory)
    vi.stubEnv(CANARY.name, CANARY.value)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  })

  it('runs claude -p with exactly the labelling flags, the prompt on stdin, in the run directory', async () => {
    // Arrange
    const fake = await install()

    // Act
    const result = await call(fake)

    // Assert
    const [record] = await fake.readRecords()
    expect({
      result,
      argv: record?.argv,
      stdin: record?.stdin,
      cwd: record?.cwd,
      variables: [record?.maxThinkingTokens, record?.disableNonessentialTraffic],
      canary: record?.canary,
    }).toStrictEqual({
      result: { type: 'answer', text: '#1 task', usage: expect.any(Object) as object },
      argv: [
        '-p',
        '--model',
        MODEL,
        '--system-prompt',
        SYSTEM_PROMPT,
        '--tools',
        '',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--setting-sources',
        'local',
        '--output-format',
        'json',
      ],
      stdin: PROMPT,
      cwd: runDirectory,
      variables: ['0', '1'],
      canary: { isArrived: true, isInStdin: false },
    })
  })

  it.each<[FakeClaudeEnvelope, object]>([
    ['usage-limit', { type: 'stop', outcome: 'limit', cause: 'limit' }],
    ['api-unreachable', { type: 'stop', outcome: 'unreachable', cause: 'unreachable' }],
    ['auth-refused', { type: 'stop', outcome: 'failed', cause: 'authentication', isMissingPrerequisite: true }],
    ['prompt-too-long', { type: 'too-long' }],
    ['other-error', { type: 'stop', outcome: 'failed', cause: 'error' }],
  ])('classifies the %s envelope as its row, holding none of the prompt', async (envelope, expected) => {
    // Arrange
    const fake = await install({ rules: [{ marker: PROMPT_TEXT, kind: 'envelope', envelope }] })

    // Act
    const result = await call(fake)

    // Assert
    expect({ result, holdsPrompt: JSON.stringify(result).includes(PROMPT_TEXT) }).toMatchObject({
      result: expected,
      holdsPrompt: false,
    })
  })

  it('stops as failed with exit code 3 when claude ends without a result', async () => {
    // Arrange
    const fake = await install({ rules: [{ marker: PROMPT_TEXT, kind: 'exit', code: 3 }] })

    // Act
    const result = await call(fake)

    // Assert
    expect(result).toMatchObject({ type: 'stop', outcome: 'failed', cause: 'no-result', exitCode: 3 })
  })

  it('kills a call that never answers once the shortened timeout passes, returning it as unanswered', async () => {
    // Arrange
    const fake = await install({ rules: [{ marker: PROMPT_TEXT, kind: 'never' }] })

    // Act
    const result = await call(fake, { timeoutMs: 500 })

    // Assert
    expect(result).toStrictEqual({ type: 'timeout', detail: 'claude timed out after 0.5s.' })
  })

  it('returns binary missing when the binary is gone after detection', async () => {
    // Arrange
    const fake = await install()
    await rm(fake.path)

    // Act
    const result = await call(fake)

    // Assert
    expect(result).toMatchObject({
      type: 'stop',
      outcome: 'failed',
      cause: 'binary-missing',
      isMissingPrerequisite: true,
    })
  })

  it("returns the run's abort as aborted", async () => {
    // Arrange
    const fake = await install({ rules: [{ marker: PROMPT_TEXT, kind: 'never' }] })
    const controller = new AbortController()

    // Act
    const calling = call(fake, { signal: controller.signal })
    controller.abort()

    // Assert
    expect(await calling).toStrictEqual({ type: 'aborted' })
  })
})
