import { describe, expect, it } from 'vitest'
import {
  causeOf,
  countStartedBy,
  goalName,
  harnessAgent,
  harnessName,
  harnessOfFilter,
  KNOWN_LABELS,
  labelsOfCause,
  outcomeStatus,
  purposeName,
  UNLABELLED,
  UNLABELLED_INLINE,
} from './labels'

describe('labels', () => {
  it('should name a failed call by its cause, a shell call by its failure', () => {
    expect(causeOf('cookbook:oc', 'rate limited')).toBe('Rate limited')
    expect(causeOf('shell', 'timeout')).toBe('Timed out')
    expect(causeOf('shell', 'command mistake')).toBe('Called the tool wrong')
  })

  it('should call a real result no cause, and a label it does not know or lacks not labelled', () => {
    expect(causeOf('shell', 'real result')).toBeNull()
    expect(causeOf('shell', 'none')).toBeNull()
    expect(causeOf('cookbook:oc', 'something new')).toBe(UNLABELLED)
    expect(causeOf('shell', null)).toBe(UNLABELLED)
  })

  it('should read a shell cause by the shell table, so one that is only another tool’s is not labelled', () => {
    expect(causeOf('shell', 'rate limited')).toBe(UNLABELLED)
  })

  it('should say a goal short, a missing one in words, and an unknown one as it is', () => {
    expect(goalName('fix a bug')).toBe('Fixing bugs')
    expect(goalName(null)).toBe('Not labelled yet')
    expect(goalName('brand new goal')).toBe('brand new goal')
  })

  it('should say a missing label in lower case where it sits in a pill', () => {
    expect(UNLABELLED_INLINE).toBe('not labelled yet')
  })

  it('should colour an outcome, and an unlabelled one hollow', () => {
    expect([outcomeStatus('done'), outcomeStatus('failed'), outcomeStatus(null)]).toEqual(['good', 'problem', 'hollow'])
  })

  it('should drop what a shell purpose explains in brackets', () => {
    expect(purposeName('check a change (format, lint, typecheck, build)')).toBe('check a change')
    expect(purposeName('explore')).toBe('explore')
    expect(purposeName(null)).toBeNull()
  })

  it('should name a harness and its agent, an unknown one as it is', () => {
    expect([harnessName('claude-code'), harnessAgent('claude-code')]).toEqual(['Claude Code', 'Claude'])
    expect([harnessName('opencode'), harnessAgent('opencode')]).toEqual(['OpenCode', 'OpenCode'])
    expect([harnessName('other'), harnessAgent('other')]).toEqual(['other', 'other'])
  })

  it('should read a harness a filter names by its alias or its name in the warehouse', () => {
    expect([harnessOfFilter('Claude'), harnessOfFilter('claude-code'), harnessOfFilter('opencode')]).toEqual([
      'claude-code',
      'claude-code',
      'opencode',
    ])
  })

  it('should give the labels behind a cause as shown, shell and other apart', () => {
    expect(labelsOfCause('Called the tool wrong')).toEqual({ shell: ['command mistake'], other: ['invalid call'] })
    expect(labelsOfCause('Timed out')).toEqual({ shell: ['timeout'], other: [] })
    expect(labelsOfCause('Tool bug')).toEqual({ shell: [], other: ['tool fault'] })
  })

  it('should give a cause no labels where it is not labelled yet or is not a cause', () => {
    expect(labelsOfCause(UNLABELLED)).toEqual({ shell: [], other: [] })
    expect(labelsOfCause('Nonsense')).toEqual({ shell: [], other: [] })
  })

  it('should know every label that is something other than not labelled yet, real results among them', () => {
    expect(KNOWN_LABELS.shell).toEqual(expect.arrayContaining(['command mistake', 'real result', 'none']))
    expect(KNOWN_LABELS.other).toEqual(expect.arrayContaining(['invalid call', 'tool fault']))
    expect(KNOWN_LABELS.other).not.toContain('real result')
  })

  it('should count the items each kind of starter began, none for a kind with no item', () => {
    expect(countStartedBy([{ startedBy: 'me' }, { startedBy: 'agent' }, { startedBy: 'me' }])).toEqual({
      me: 2,
      agent: 1,
      script: 0,
    })
    expect(countStartedBy([])).toEqual({ me: 0, agent: 0, script: 0 })
  })
})
