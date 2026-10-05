import { KNOWN_TOOLS } from '@log-book/adapter-api'
import { describe, expect, it } from 'vitest'
import { toolNameOf } from './families.js'

const SERVER = 'orchestra'

describe('toolNameOf', () => {
  // Built from KNOWN_TOOLS's keys, so this file never spells one.
  it.each([...KNOWN_TOOLS].map(([key, family]) => [key, family] as const))(
    'gives the known tool %s its family bare, in upper case and behind a server',
    (key, family) => {
      // Act
      const names = [key, key.toUpperCase(), `mcp__${SERVER}__${key}`].map((name) => toolNameOf(name))

      // Assert
      expect(names).toStrictEqual([
        { server: null, bareName: key, family },
        { server: null, bareName: key.toUpperCase(), family },
        { server: SERVER, bareName: key, family },
      ])
    }
  )

  it('gives a name in no table its server family with a server, and other without', () => {
    // Act
    const names = [toolNameOf('mcp__tracker__create_issue'), toolNameOf('ExitPlanMode')]

    // Assert
    expect(names).toStrictEqual([
      { server: 'tracker', bareName: 'create_issue', family: 'mcp:tracker' },
      { server: null, bareName: 'ExitPlanMode', family: 'other' },
    ])
  })

  it('splits a server whose own name holds __ at its first __', () => {
    // Act
    const name = toolNameOf('mcp__team__tracker__create_issue')

    // Assert
    expect(name).toStrictEqual({ server: 'team', bareName: 'tracker__create_issue', family: 'mcp:team' })
  })

  it.each([
    ['BASH', 'shell'],
    ['bash', 'shell'],
    ['Read', 'read'],
    ['EDIT', 'edit'],
    ['write', 'edit'],
    ['MultiEdit', 'edit'],
    ['notebookEdit', 'edit'],
    ['GREP', 'search'],
    ['glob', 'search'],
    ['TASK', 'subagent'],
    ['agent', 'subagent'],
    ['WebFetch', 'web'],
    ['webSEARCH', 'web'],
    ['TodoWrite', 'todo'],
    ['TASKCREATE', 'todo'],
    ['taskUpdate', 'todo'],
    ['SKILL', 'skill'],
    ['ToolSearch', 'tool-search'],
    ['askUserQuestion', 'question'],
    ['MONITOR', 'wait'],
    ['TaskOutput', 'wait'],
  ])('gives %s the family %s', (name, family) => {
    // Act
    const tool = toolNameOf(name)

    // Assert
    expect(tool).toStrictEqual({ server: null, bareName: name, family })
  })
})
