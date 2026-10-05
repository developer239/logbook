import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { classifyBatchOutput } from './batch-result.js'

const envelope = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(new URL(`../../fixtures/claude/2.1.286/${name}.json`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >

const errorResult = (fields: Record<string, unknown>): string =>
  JSON.stringify({ is_error: true, api_error_status: null, terminal_reason: 'api_error', result: '', ...fields })

describe('classifyBatchOutput', () => {
  it('reads an answer with its token usage from the terminal result object', async () => {
    // Arrange
    const success = await envelope('success')

    // Act
    const result = classifyBatchOutput(JSON.stringify(success), '', 0)

    // Assert
    expect(result).toStrictEqual({
      type: 'answer',
      text: success.result,
      usage: { inputTokens: 394, outputTokens: 139, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })

  it.each([
    ['the recorded 429', 'usage-limit', { type: 'stop', outcome: 'limit', cause: 'limit' }],
    [
      'the recorded dropped connection',
      'api-unreachable',
      { type: 'stop', outcome: 'unreachable', cause: 'unreachable' },
    ],
    [
      'the recorded 401',
      'auth-refused',
      { type: 'stop', outcome: 'failed', cause: 'authentication', isMissingPrerequisite: true },
    ],
    ['the recorded prompt too long', 'prompt-too-long', { type: 'too-long' }],
    [
      'the recorded server error',
      'other-error',
      { type: 'stop', outcome: 'failed', cause: 'error', isMissingPrerequisite: false },
    ],
  ])('classifies %s as its row', async (_case, name, expected) => {
    // Act
    const result = classifyBatchOutput(JSON.stringify(await envelope(name)), '', 1)

    // Assert
    expect(result).toMatchObject(expected)
  })

  it.each([
    [
      'a spend limit text',
      { result: "You've hit your monthly spend limit · resets 1st" },
      { outcome: 'limit', cause: 'limit' },
    ],
    [
      'No response from API',
      { result: 'API Error: No response from API after 3 attempts' },
      { outcome: 'unreachable', cause: 'unreachable' },
    ],
    [
      'ENOTFOUND',
      { result: 'getaddrinfo ENOTFOUND api.anthropic.com' },
      { outcome: 'unreachable', cause: 'unreachable' },
    ],
    [
      'a model the plan does not offer',
      { api_error_status: 404, result: 'There is an issue with the selected model.' },
      { outcome: 'failed', cause: 'error' },
    ],
  ])('classifies %s by its row', (_case, fields, expected) => {
    // Act
    const result = classifyBatchOutput(errorResult(fields), '', 1)

    // Assert
    expect(result).toMatchObject({ type: 'stop', ...expected })
  })

  it('classifies a blocking limit as too long, before any other error', () => {
    // Act
    const result = classifyBatchOutput(
      errorResult({ terminal_reason: 'blocking_limit', result: 'Context limit reached' }),
      '',
      1
    )

    // Assert
    expect(result).toStrictEqual({ type: 'too-long', detail: 'Context limit reached' })
  })

  it('stops as failed with the exit code when the process ended without a result object', () => {
    // Act
    const result = classifyBatchOutput('', 'Segmentation fault\n', 3)

    // Assert
    expect(result).toStrictEqual({
      type: 'stop',
      outcome: 'failed',
      cause: 'no-result',
      isMissingPrerequisite: false,
      exitCode: 3,
      detail: 'Segmentation fault',
    })
  })

  it('cuts a failure text to its last 300 characters', () => {
    // Arrange
    const text = `${'x'.repeat(400)}the end`

    // Act
    const result = classifyBatchOutput(errorResult({ api_error_status: 500, result: text }), '', 1)

    // Assert
    expect(result).toMatchObject({ detail: text.slice(-300) })
  })
})
