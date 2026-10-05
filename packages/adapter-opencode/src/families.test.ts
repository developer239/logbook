import { KNOWN_TOOLS } from '@log-book/adapter-api'
import { describe, expect, it } from 'vitest'
import { toolNameOf } from './families.js'

describe('toolNameOf', () => {
  // Built from KNOWN_TOOLS's keys, so this file never spells one.
  it.each([...KNOWN_TOOLS].map(([key, family]) => [key, family] as const))(
    'gives the known tool %s its family bare and in upper case, with no server',
    (key, family) => {
      // Act
      const names = [key, key.toUpperCase()].map((name) => toolNameOf(name))

      // Assert
      expect(names).toStrictEqual([
        { server: null, bareName: key, family },
        { server: null, bareName: key.toUpperCase(), family },
      ])
    }
  )

  it('gives a name in no table other, a plugin tool and a Code Mode program included', () => {
    // Act
    const names = ['tracker_create_issue', 'execute', 'ExitPlanMode'].map((name) => toolNameOf(name))

    // Assert
    expect(names).toStrictEqual([
      { server: null, bareName: 'tracker_create_issue', family: 'other' },
      { server: null, bareName: 'execute', family: 'other' },
      { server: null, bareName: 'ExitPlanMode', family: 'other' },
    ])
  })

  it.each([
    ['BASH', 'shell'],
    ['Shell', 'shell'],
    ['READ', 'read'],
    ['Edit', 'edit'],
    ['WRITE', 'edit'],
    ['Patch', 'edit'],
    ['APPLY_PATCH', 'edit'],
    ['Grep', 'search'],
    ['GLOB', 'search'],
    ['List', 'search'],
    ['TASK', 'subagent'],
    ['SubAgent', 'subagent'],
    ['WebFetch', 'web'],
    ['WEBSEARCH', 'web'],
    ['TodoWrite', 'todo'],
    ['todoRead', 'todo'],
    ['Skill', 'skill'],
    ['QUESTION', 'question'],
  ])('gives %s the family %s', (name, family) => {
    // Act
    const tool = toolNameOf(name)

    // Assert
    expect(tool).toStrictEqual({ server: null, bareName: name, family })
  })
})
