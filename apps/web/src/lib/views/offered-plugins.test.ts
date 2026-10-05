import { describe, expect, it } from 'vitest'
import type { IPluginServer, IPluginTool } from '../plugins'
import { offeredPlugins } from './offered-plugins'

const tool = (name: string, fields: Partial<IPluginTool> = {}): IPluginTool => ({
  name,
  cookbookModule: null,
  calls: 0,
  nameTokens: 10,
  definitionTokens: null,
  loaded: null,
  addedInTurn: null,
  removedInTurn: null,
  ...fields,
})

const server = (name: string, tools: IPluginTool[], fields: Partial<IPluginServer> = {}): IPluginServer => ({
  key: name,
  name,
  startState: 'connected',
  error: null,
  tools,
  ...fields,
})

describe('offeredPlugins', () => {
  it('should give a block to a server with a tool called or loaded and a line to the rest', () => {
    const view = offeredPlugins([
      server('used', [tool('a', { calls: 2 }), tool('b')]),
      server('quiet', [tool('c'), tool('d')]),
    ])

    expect(view.blocks.map((block) => block.name)).toEqual(['used'])
    expect(view.quiet).toEqual([{ name: 'quiet', tools: 2, tokens: 20 }])
  })

  it('should give a block to a server that did not connect, and group the names of its other tools by plugin', () => {
    const view = offeredPlugins([
      server('down', [tool('a', { cookbookModule: 'jira' }), tool('b', { cookbookModule: 'jira' }), tool('c')], {
        startState: 'failed',
        error: 'timed out',
      }),
    ])

    expect(view.blocks[0]?.names).toEqual([
      { cookbookModule: 'jira', tools: 2, tokens: 20 },
      { cookbookModule: null, tools: 1, tokens: 10 },
    ])
    expect(view.failedCount).toBe(1)
  })

  it('should list called tools first, most called first, then loaded ones by what their definitions cost', () => {
    const view = offeredPlugins([
      server('s', [
        tool('loaded small', { loaded: 'start', definitionTokens: 100 }),
        tool('called once', { calls: 1 }),
        tool('loaded big', { loaded: 3, definitionTokens: 900 }),
        tool('called twice', { calls: 2 }),
        tool('not touched'),
      ]),
    ])

    expect(view.blocks[0]?.touched.map((row) => row.name)).toEqual([
      'called twice',
      'called once',
      'loaded big',
      'loaded small',
    ])
  })

  it('should fall through to the definitions for two tools that were both never called', () => {
    const view = offeredPlugins([
      server('s', [
        tool('small', { loaded: 'start', definitionTokens: 100 }),
        tool('unknown', { loaded: 2 }),
        tool('big', { loaded: 2, definitionTokens: 900 }),
      ]),
    ])

    expect(view.blocks[0]?.touched.map((row) => row.name)).toEqual(['big', 'small', 'unknown'])
  })

  it('should fall through to the definitions for two tools with the same calls', () => {
    const view = offeredPlugins([
      server('s', [
        tool('small', { calls: 3, definitionTokens: 100 }),
        tool('big', { calls: 3, definitionTokens: 900 }),
      ]),
    ])

    expect(view.blocks[0]?.touched.map((row) => row.name)).toEqual(['big', 'small'])
  })

  it('should order blocks by tools used, then by tools touched', () => {
    const view = offeredPlugins([
      server('loaded only', [tool('a', { loaded: 1 }), tool('b', { loaded: 1 })]),
      server('one used', [tool('c', { calls: 1 })]),
      server('two used', [tool('d', { calls: 1 }), tool('e', { calls: 1 })]),
    ])

    expect(view.blocks.map((block) => block.name)).toEqual(['two used', 'one used', 'loaded only'])
  })

  it('should note the turns the tools of a late server arrived in', () => {
    const view = offeredPlugins([
      server('late', [tool('a', { calls: 1, addedInTurn: 4 }), tool('b', { addedInTurn: 2 }), tool('c')]),
    ])

    expect(view.blocks[0]?.later).toEqual([4, 2])
  })

  it('should fold the servers that needed a sign-in into one line of their sign-in tools', () => {
    const view = offeredPlugins([
      server('one', [tool('authenticate'), tool('complete_authentication')], { startState: 'needs-sign-in' }),
      server('two', [tool('authenticate')], { startState: 'needs-sign-in' }),
    ])

    expect(view.blocks).toEqual([])
    expect(view.signIn).toEqual({ names: ['one', 'two'], tools: 3, tokens: 30 })
  })

  it('should add up what was offered, loaded, used and loaded without use', () => {
    const view = offeredPlugins([
      server('s', [
        tool('a', { calls: 1, loaded: 'start', definitionTokens: 400 }),
        tool('b', { loaded: 2, definitionTokens: 600 }),
        tool('c'),
      ]),
    ])

    expect(view).toMatchObject({
      offeredCount: 3,
      offerTokens: 30,
      loadedCount: 2,
      usedCount: 1,
      idleCount: 1,
      definitions: '1k',
    })
  })

  it('should say the definitions cost is unknown where none was recorded, or partly unknown', () => {
    const none = offeredPlugins([server('s', [tool('a', { loaded: 'start' })])])
    const some = offeredPlugins([
      server('s', [tool('a', { loaded: 'start', definitionTokens: 400 }), tool('b', { loaded: 'start' })]),
    ])

    expect(none.definitions).toBe('unknown')
    expect(some.definitions).toBe('400 and some unknown')
  })
})
