import { shellRulePurpose, toolFailureRuleCause } from '@log-book/engine'
import { describe, expect, it } from 'vitest'
import { TOOLS, type IToolEntry } from './tools.js'

const ENTRIES: readonly (readonly [string, IToolEntry])[] = [
  ...Object.entries(TOOLS.project.shop),
  ...Object.entries(TOOLS.project.billing),
  ...Object.entries(TOOLS.project['field-guide']),
  ...Object.entries(TOOLS.shared),
]

describe('tools.ts labels', () => {
  it('tags every shell call with its labels and every failed call outside the shell with its cause, and no other', () => {
    // Act
    const mistagged = ENTRIES.filter(
      ([, entry]) =>
        (entry.shell !== null) !== (entry.family === 'shell') ||
        (entry.failure !== null) !== (entry.family !== 'shell' && entry.status === 'error') ||
        (entry.family === 'shell' && (entry.shell?.failure === 'none') !== (entry.status === 'completed'))
    )

    // Assert
    expect(mistagged.map(([name]) => name)).toStrictEqual([])
  })

  it.each(ENTRIES.filter(([, entry]) => entry.shell !== null))(
    "agrees with the engine's purpose rules on the shell call %s",
    (_name, entry) => {
      // Act
      const purpose = shellRulePurpose(String(entry.input.command))

      // Assert
      expect(purpose).toBe(entry.shell?.isRuleSettled === true ? entry.shell.purpose : null)
    }
  )

  it.each(ENTRIES.filter(([, entry]) => entry.failure !== null))(
    "agrees with the engine's cause rules on the failed call %s",
    (_name, entry) => {
      // Act
      const cause = toolFailureRuleCause(entry.result)

      // Assert
      expect(cause).toBe(entry.failure?.isRuleSettled === true ? entry.failure.cause : null)
    }
  )

  it("leaves the claude -p run's purpose to the model, as its labels say", () => {
    // Act
    const purpose = shellRulePurpose('claude -p "explain in one paragraph what the cart badge counts"')

    // Assert
    expect({ purpose, isRuleSettled: TOOLS.scriptedRun.isRuleSettled }).toStrictEqual({
      purpose: null,
      isRuleSettled: false,
    })
  })
})
