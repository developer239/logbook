import { describe, expect, it } from 'vitest'
import { parseStepsQuery } from '../queries/steps'
import { stepsHeading } from './steps'

const heading = (search: string): string => stepsHeading(parseStepsQuery(new URLSearchParams(search)))

describe('stepsHeading', () => {
  it('should say what the list holds the way the card that links to it does', () => {
    expect(heading('')).toBe('Steps')
    expect(heading('failed=1')).toBe('Failed steps')
    expect(heading('real=1')).toBe('Failures that were real results')
    expect(heading('loop=1')).toBe('Steps in retry loops')
    expect(heading('cause=Tool+bug')).toBe('Failed: Tool bug')
    expect(heading('slow=Bash')).toBe('Unusually slow: Bash')
  })

  it('should name the tool the list is narrowed to', () => {
    expect(heading('cause=Tool+bug&tool=oc_run')).toBe('Failed: Tool bug · oc_run')
  })

  it('should read a cause before a slow call, and either before a plain failure', () => {
    expect(heading('failed=1&cause=Environment&slow=Read')).toBe('Failed: Environment')
    expect(heading('failed=1&slow=Read')).toBe('Unusually slow: Read')
  })
})
