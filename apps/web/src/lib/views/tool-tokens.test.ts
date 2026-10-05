import { describe, expect, it } from 'vitest'
import type { IToolSource, IToolTokens } from '../queries/tool-tokens'
import { cardTools, mostTotal, pluginGroups, toolGroups } from './tool-tokens'

const plugin = (name: string): IToolSource => ({ kind: 'plugin', name })
const BUILT_IN: IToolSource = { kind: 'built-in', name: 'Built in' }

const tool = (name: string, source: IToolSource, fields: Partial<IToolTokens> = {}): IToolTokens => ({
  name,
  source,
  calls: 1,
  typicalTokens: 10,
  totalTokens: 10,
  definitionTokens: null,
  isRetired: false,
  ...fields,
})

describe('cardTools', () => {
  it('should leave out the tools nobody called, and scale the bars by the largest called', () => {
    const rows = [
      tool('read', BUILT_IN, { totalTokens: 900 }),
      tool('unused', plugin('oc'), { calls: 0, totalTokens: 0 }),
    ]

    expect(cardTools(rows)).toMatchObject({ called: 1, most: 900 })
    expect(cardTools(rows).shown.map((row) => row.name)).toEqual(['read'])
  })

  it('should show the first ten tools while counting all that were called', () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      tool(`tool ${String(index)}`, BUILT_IN, { totalTokens: 100 - index })
    )

    expect(cardTools(rows).shown).toHaveLength(10)
    expect(cardTools(rows).called).toBe(12)
  })

  it('should have a bar scale of 1 for no tools', () => {
    expect(cardTools([])).toEqual({ shown: [], called: 0, most: 1 })
    expect(mostTotal([])).toBe(1)
  })
})

describe('pluginGroups', () => {
  it('should put plugins first and scale their bars against each other', () => {
    const rows = [
      tool('read', BUILT_IN, { totalTokens: 5000 }),
      tool('oc_run', plugin('oc'), { totalTokens: 300 }),
      tool('jira_get', plugin('jira'), { totalTokens: 700 }),
    ]
    const { groups, mostPlugin } = pluginGroups(rows)

    expect(groups.map((group) => group.source.name)).toEqual(['jira', 'oc', 'Built in'])
    expect(mostPlugin).toBe(700)
  })

  it('should have no plugin to scale against where there is none', () => {
    expect(pluginGroups([tool('read', BUILT_IN)]).mostPlugin).toBe(0)
  })
})

describe('toolGroups', () => {
  it('should total the calls and tokens of a plugin, count its unused and removed tools and add up its definitions', () => {
    const [group] = toolGroups([
      tool('oc_run', plugin('oc'), { calls: 4, totalTokens: 400, definitionTokens: 50 }),
      tool('oc_old', plugin('oc'), { calls: 2, totalTokens: 60, isRetired: true }),
      tool('oc_idle', plugin('oc'), { calls: 0, typicalTokens: null, totalTokens: 0, definitionTokens: 30 }),
    ])

    expect(group).toMatchObject({ calls: 6, totalTokens: 460, unusedTools: 1, retiredTools: 1, definitionTokens: 80 })
    expect(group?.tools).toHaveLength(3)
  })

  it('should put the group that costs the most first, and the one with larger definitions first among equals', () => {
    const groups = toolGroups([
      tool('a', plugin('small'), { totalTokens: 10, definitionTokens: 5 }),
      tool('b', plugin('large'), { totalTokens: 99 }),
      tool('c', plugin('defs'), { totalTokens: 10, definitionTokens: 40 }),
    ])

    expect(groups.map((group) => group.source.name)).toEqual(['large', 'defs', 'small'])
  })

  it('should keep a plugin and a built-in tool of one name in separate groups', () => {
    const groups = toolGroups([tool('x', plugin('Built in')), tool('y', BUILT_IN)])

    expect(groups).toHaveLength(2)
  })
})
