import { describe, expect, it } from 'vitest'
import { stepKind } from './step-kind'

describe('stepKind', () => {
  it('should read a model request as one', () => {
    expect(stepKind({ kind: 'model' })).toBe('model')
  })

  it('should read a failed call as one before anything else about it', () => {
    expect(stepKind({ kind: 'tool', cause: 'Tool bug', started: {}, durationMs: null })).toBe('fail')
  })

  it('should read a call that started an agent as one', () => {
    expect(stepKind({ kind: 'tool', cause: null, started: {}, durationMs: 1_000 })).toBe('agent')
  })

  it('should tell a call with no time recorded from one with a time', () => {
    expect(stepKind({ kind: 'tool', cause: null, started: null, durationMs: null })).toBe('untimed')
    expect(stepKind({ kind: 'tool', cause: null, started: null, durationMs: 40 })).toBe('tool')
  })

  it('should read a call of the steps list, which has no kind and starts no agent', () => {
    expect(stepKind({ cause: 'Environment', durationMs: 5 })).toBe('fail')
    expect(stepKind({ cause: null, durationMs: null })).toBe('untimed')
    expect(stepKind({ cause: null, durationMs: 5 })).toBe('tool')
  })
})
