import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSubprocess, type ISubprocessResult } from '@log-book/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installFakeClaude,
  type FakeClaudeEnvelope,
  type IFakeClaude,
  type IFakeClaudeScenario,
} from './fake-claude.js'

const TIMEOUT_MS = 5000
const SYSTEM_PROMPT = 'Classify each shell call.'
const ENVELOPES = new URL('../../fixtures/claude/2.1.286/', import.meta.url)
const LABEL_ARGS = ['-p', '--model', 'claude-haiku-4-5', '--system-prompt', SYSTEM_PROMPT, '--output-format', 'json']

const batch = (...records: string[]): string =>
  records.map((text, index) => `### #0${String(index)}\n${text}\n`).join('')

const readEnvelope = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`${name}.json`, ENVELOPES), 'utf8')) as unknown

describe('installFakeClaude', () => {
  let directory = ''
  let bin = ''
  let work = ''

  const install = (scenario: IFakeClaudeScenario = {}): Promise<IFakeClaude> =>
    installFakeClaude(bin, { answers: [{ systemPrompt: SYSTEM_PROMPT, answer: '3 0' }], ...scenario })

  const call = (
    args: string[],
    input: string,
    env: Record<string, string> = {},
    timeoutMs = TIMEOUT_MS
  ): Promise<ISubprocessResult> =>
    runSubprocess({ command: 'claude', args, input, timeoutMs, label: 'claude', cwd: work, env: { PATH: bin, ...env } })

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-fake-claude-')))
    bin = join(directory, 'bin')
    work = join(directory, 'work')
    await mkdir(bin)
    await mkdir(work)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('runs with a PATH holding only its own directory and answers --version and auth status', async () => {
    // Arrange
    await install()

    // Act
    const version = await call(['--version'], '')
    const auth = await call(['auth', 'status', '--json'], '')

    // Assert
    expect({
      version: version.stdout,
      auth: JSON.parse(auth.stdout) as unknown,
      authExit: auth.exitCode,
    }).toStrictEqual({
      version: '2.1.286 (Claude Code)\n',
      auth: await readEnvelope('auth-status'),
      authExit: 0,
    })
  })

  it('answers another version and a signed-out status from the scenario', async () => {
    // Arrange
    await install({ version: '2.0.10', auth: { loggedIn: false } })

    // Act
    const version = await call(['--version'], '')
    const auth = await call(['auth', 'status', '--json'], '')

    // Assert
    expect({
      version: version.stdout,
      loggedIn: (JSON.parse(auth.stdout) as { loggedIn: boolean }).loggedIn,
      authExit: auth.exitCode,
    }).toStrictEqual({
      version: '2.0.10 (Claude Code)\n',
      loggedIn: false,
      authExit: 1,
    })
  })

  it('records each call and answers one line per tag', async () => {
    // Arrange
    const fake = await install()
    const input = batch('(ok) ls', '(FAILED) make')
    const env = { MAX_THINKING_TOKENS: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HOME: directory }

    // Act
    const first = await call(LABEL_ARGS, input, env)
    await call(LABEL_ARGS, input, env)
    const records = await fake.readRecords()

    // Assert
    expect((JSON.parse(first.stdout) as { result: string }).result).toBe('#00 3 0\n#01 3 0')
    expect(records).toStrictEqual(
      [1, 2].map((counter) => ({
        counter,
        argv: LABEL_ARGS,
        model: 'claude-haiku-4-5',
        stdin: input,
        cwd: work,
        cwdExisted: true,
        cwdWasEmpty: true,
        maxThinkingTokens: '0',
        disableNonessentialTraffic: '1',
        hasApiKey: false,
        isApiKeyInStdin: false,
        otherVariables: expect.arrayContaining(['HOME', 'PATH']) as string[],
        canary: null,
        cwdStillExists: true,
      }))
    )
  })

  it('checks that the canary and the API key pass through and stay out of stdin, recording no value', async () => {
    // Arrange
    const canary = { name: 'LOGBOOK_TEST_CANARY', value: 'canary-7f3a' }
    const apiKey = 'invented-key-0000'
    const fake = await install({ canary })

    // Act
    await call(LABEL_ARGS, batch('(ok) ls'), { [canary.name]: canary.value, ANTHROPIC_API_KEY: apiKey })
    const [record] = await fake.readRecords()
    const recordFile = await readFile(join(bin, 'claude-calls.jsonl'), 'utf8')

    // Assert
    expect({
      canary: record?.canary,
      hasApiKey: record?.hasApiKey,
      isApiKeyInStdin: record?.isApiKeyInStdin,
      isKeyRecorded: recordFile.includes(apiKey),
      isCanaryRecorded: recordFile.includes(canary.value),
    }).toStrictEqual({
      canary: { isArrived: true, isInStdin: false },
      hasApiKey: true,
      isApiKeyInStdin: false,
      isKeyRecorded: false,
      isCanaryRecorded: false,
    })
  })

  it.each<FakeClaudeEnvelope>(['usage-limit', 'api-unreachable', 'auth-refused', 'other-error', 'prompt-too-long'])(
    'answers the %s envelope to the batch carrying its marker',
    async (envelope) => {
      // Arrange
      await install({ rules: [{ marker: 'marker-e', kind: 'envelope', envelope }] })

      // Act
      const result = await call(LABEL_ARGS, batch('(ok) ls marker-e'))

      // Assert
      expect({ envelope: JSON.parse(result.stdout) as unknown, exitCode: result.exitCode }).toStrictEqual({
        envelope: await readEnvelope(envelope),
        exitCode: 1,
      })
    }
  )

  it('leaves out the tag of the record carrying the marker', async () => {
    // Arrange
    await install({ rules: [{ marker: 'marker-o', kind: 'omit-tag' }] })

    // Act
    const result = await call(LABEL_ARGS, batch('(ok) ls', '(ok) pwd marker-o', '(ok) env'))

    // Assert
    expect((JSON.parse(result.stdout) as { result: string }).result).toBe('#00 3 0\n#02 3 0')
  })

  it('answers a delayed batch and exits with the code of an exit rule and no result', async () => {
    // Arrange
    await install({
      rules: [
        { marker: 'marker-d', kind: 'delay', ms: 50 },
        { marker: 'marker-x', kind: 'exit', code: 3 },
      ],
    })

    // Act
    const delayed = await call(LABEL_ARGS, batch('(ok) ls marker-d'))
    const exited = await call(LABEL_ARGS, batch('(ok) ls marker-x'))

    // Assert
    expect({
      delayed: (JSON.parse(delayed.stdout) as { result: string }).result,
      exited: { stdout: exited.stdout, exitCode: exited.exitCode },
    }).toStrictEqual({ delayed: '#00 3 0', exited: { stdout: '', exitCode: 3 } })
  })

  it('holds a batch until the named file exists', async () => {
    // Arrange
    const release = join(directory, 'release')
    const fake = await install({ rules: [{ marker: 'marker-h', kind: 'hold', file: release }] })
    let isAnswered = false
    const held = call(LABEL_ARGS, batch('(ok) ls marker-h')).then((result) => {
      isAnswered = true
      return result
    })
    // The fake has read the batch once it has recorded the call.
    await vi.waitFor(async () => expect(await fake.readRecords()).toHaveLength(1), { timeout: TIMEOUT_MS })
    const wasAnsweredBefore = isAnswered

    // Act
    await writeFile(release, '')
    const result = await held

    // Assert
    expect({ wasAnsweredBefore, result: (JSON.parse(result.stdout) as { result: string }).result }).toStrictEqual({
      wasAnsweredBefore: false,
      result: '#00 3 0',
    })
  })

  it('never answers an unanswered batch until killed', async () => {
    // Arrange
    await install({ rules: [{ marker: 'marker-n', kind: 'never' }] })

    // Act
    const calling = call(LABEL_ARGS, batch('(ok) ls marker-n'), {}, 500)

    // Assert
    await expect(calling).rejects.toThrow(expect.objectContaining({ code: 'TIMEOUT' }))
  })
})

describe('recorded envelopes', () => {
  it('hold only the allowlisted fields and no email address, UUID or home path', async () => {
    // Arrange
    const names = (await readdir(ENVELOPES)).toSorted()
    const resultFields = ['is_error', 'api_error_status', 'terminal_reason', 'subtype', 'result', 'usage']
    const authFields = ['loggedIn', 'authMethod', 'apiProvider']

    // Act
    const files = await Promise.all(
      names.map(async (name) => ({ name, text: await readFile(new URL(name, ENVELOPES), 'utf8') }))
    )
    const problems = files.flatMap(({ name, text }) => {
      const found: string[] = []
      if (/[\w.+-]+@[\w-]+\.[\w.]+/u.test(text)) {
        found.push(`${name}: an email address`)
      }
      if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu.test(text)) {
        found.push(`${name}: a UUID`)
      }
      if (text.includes(homedir())) {
        found.push(`${name}: a home path`)
      }
      if (name.endsWith('.json')) {
        const allowed = name === 'auth-status.json' ? authFields : resultFields
        const extra = Object.keys(JSON.parse(text) as Record<string, unknown>).filter((key) => !allowed.includes(key))
        found.push(...extra.map((key) => `${name}: field ${key}`))
      }
      return found
    })

    // Assert
    expect({ names, problems }).toStrictEqual({
      names: [
        'api-unreachable.json',
        'auth-refused.json',
        'auth-status.json',
        'other-error.json',
        'prompt-too-long.json',
        'success.json',
        'usage-limit.json',
        'version.txt',
      ],
      problems: [],
    })
  })
})
