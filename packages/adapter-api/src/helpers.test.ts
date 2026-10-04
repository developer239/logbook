import { describe, expect, it } from 'vitest'
import { childIdOf, compareHarnessVersions, sessionIdOf, timeSpan, unknownEvent } from './helpers.js'

describe('sessionIdOf and childIdOf', () => {
  it('build a session id and a child id', () => {
    // Arrange
    const sessionId = sessionIdOf('opencode', 'ses_example01')

    // Act
    const childId = childIdOf(sessionId, 'msg_example03')

    // Assert
    expect([sessionId, childId]).toStrictEqual(['opencode:ses_example01', 'opencode:ses_example01/msg_example03'])
  })
})

describe('timeSpan', () => {
  it('is null at both ends for no messages', () => {
    // Arrange
    const messages: { createdAt: number; completedAt: number | null }[] = []

    // Act
    const span = timeSpan(messages)

    // Assert
    expect(span).toStrictEqual({ startedAt: null, endedAt: null })
  })

  it('ends at the created time of a message without a completed time', () => {
    // Arrange
    const messages = [
      { createdAt: 1_000, completedAt: 1_500 },
      { createdAt: 2_000, completedAt: null },
    ]

    // Act
    const span = timeSpan(messages)

    // Assert
    expect(span).toStrictEqual({ startedAt: 1_000, endedAt: 2_000 })
  })

  it('ends at the latest completion, even when an earlier message completed after a later one', () => {
    // Arrange
    const messages = [
      { createdAt: 1_000, completedAt: 9_000 },
      { createdAt: 2_000, completedAt: 3_000 },
    ]

    // Act
    const span = timeSpan(messages)

    // Assert
    expect(span).toStrictEqual({ startedAt: 1_000, endedAt: 9_000 })
  })
})

describe('compareHarnessVersions', () => {
  it('orders versions numerically and gives null for one that does not parse', () => {
    // Arrange
    const pairs: [string, string][] = [
      ['2.1', '2.1'],
      ['2.10', '2.9'],
      ['2.1.286', '2.2'],
      ['2.1', 'next'],
    ]

    // Act
    const signs = pairs.map(([first, second]) => {
      const result = compareHarnessVersions(first, second)
      return result === null ? null : Math.sign(result)
    })

    // Assert
    expect(signs).toStrictEqual([0, 1, -1, null])
  })
})

describe('unknownEvent', () => {
  it('builds the event for an unknown record and for an unrecognised field value', () => {
    // Arrange
    const sessionId = 'test-harness:s1'
    const record = { type: 'example_kind', uuid: 'u-1' }

    // Act
    const events = [
      unknownEvent(sessionId, 'u-1', 1_000, {
        what: 'record',
        type: 'example_kind',
        harnessVersion: '2.1.300',
        raw: record,
      }),
      unknownEvent(sessionId, 'u-2', 2_000, { what: 'field', field: 'entrypoint', value: 'sdk-ts' }),
    ]

    // Assert
    expect(events).toStrictEqual([
      {
        id: 'test-harness:s1/u-1',
        sessionId,
        kind: 'unknown',
        at: 1_000,
        dataJson:
          '{"what":"record","type":"example_kind","harnessVersion":"2.1.300","raw":{"type":"example_kind","uuid":"u-1"}}',
      },
      {
        id: 'test-harness:s1/u-2',
        sessionId,
        kind: 'unknown',
        at: 2_000,
        dataJson: '{"what":"field","field":"entrypoint","value":"sdk-ts"}',
      },
    ])
  })
})
