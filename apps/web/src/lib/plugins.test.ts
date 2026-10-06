import { describe, expect, it } from 'vitest'
import { calledPlugins, pluginServers, type IPluginInputs, type IToolAnnouncement } from './plugins'

const announce = (at: number, fields: Partial<IToolAnnouncement>): IToolAnnouncement => ({
  at,
  added: [],
  removed: [],
  surfaced: [],
  pendingServers: null,
  needsAuthServers: null,
  failedServers: null,
  ...fields,
})

const inputs = (announcements: IToolAnnouncement[], fields: Partial<IPluginInputs> = {}): IPluginInputs => ({
  announcements,
  firstRequestAt: 100,
  turnAt: (at) => (at < 1000 ? 1 : 2),
  loadedInTurn: new Map(),
  callsOf: () => 0,
  definitionOf: () => null,
  ...fields,
})

describe('pluginServers', () => {
  it('should have nothing to say for a session that announced no tools', () => {
    expect(pluginServers(inputs([]))).toBeNull()
  })

  it('should group the MCP tools offered at the start by server and tell sent definitions from loaded ones', () => {
    const servers = pluginServers(
      inputs(
        [
          announce(50, {
            added: ['WebFetch', 'mcp__claude_ai_Docs__batch', 'mcp__opencode__jira_get_issue', 'mcp__opencode__launch'],
            surfaced: ['mcp__claude_ai_Docs__batch'],
            pendingServers: [],
            needsAuthServers: [],
            failedServers: [],
          }),
        ],
        {
          loadedInTurn: new Map([['mcp__opencode__launch', 2]]),
          callsOf: (full) => (full === 'mcp__opencode__launch' ? 3 : 0),
          definitionOf: (full) => (full.startsWith('mcp__opencode__') ? 400 : null),
        }
      )
    )

    expect(servers).toEqual([
      {
        key: 'claude_ai_Docs',
        name: 'claude_ai_Docs',
        startState: 'connected',
        error: null,
        tools: [
          {
            name: 'batch',
            calls: 0,
            nameTokens: 7,
            definitionTokens: null,
            loaded: 'start',
            addedInTurn: null,
            removedInTurn: null,
          },
        ],
      },
      {
        key: 'opencode',
        name: 'opencode',
        startState: 'connected',
        error: null,
        tools: [
          {
            name: 'jira_get_issue',
            calls: 0,
            nameTokens: 8,
            definitionTokens: 400,
            loaded: null,
            addedInTurn: null,
            removedInTurn: null,
          },
          {
            name: 'launch',
            calls: 3,
            nameTokens: 6,
            definitionTokens: 400,
            loaded: 2,
            addedInTurn: null,
            removedInTurn: null,
          },
        ],
      },
    ])
  })

  it('should keep a server that failed at the start and the turn its tools arrived in', () => {
    const servers = pluginServers(
      inputs([
        announce(50, {
          added: ['mcp__claude_ai_Slack__authenticate'],
          needsAuthServers: ['claude.ai Slack'],
          failedServers: [{ name: 'opencode', error: 'timed out after 30000ms' }],
        }),
        announce(2000, { added: ['mcp__opencode__launch'], failedServers: [] }),
      ])
    )

    expect(servers?.map((server) => [server.name, server.startState, server.error, server.tools])).toEqual([
      [
        'claude.ai Slack',
        'needs-sign-in',
        null,
        [
          {
            name: 'authenticate',
            calls: 0,
            nameTokens: 9,
            definitionTokens: null,
            loaded: null,
            addedInTurn: null,
            removedInTurn: null,
          },
        ],
      ],
      [
        'opencode',
        'failed',
        'timed out after 30000ms',
        [
          {
            name: 'launch',
            calls: 0,
            nameTokens: 6,
            definitionTokens: null,
            loaded: null,
            addedInTurn: 2,
            removedInTurn: null,
          },
        ],
      ],
    ])
  })

  it('should take a re-announcement after a compaction as nothing new and a drop as a removal', () => {
    const all = ['mcp__opencode__launch', 'mcp__opencode__jira_get_issue']
    const servers = pluginServers(
      inputs([
        announce(50, { added: all }),
        announce(500, { removed: ['mcp__opencode__jira_get_issue'] }),
        announce(1500, { added: ['mcp__opencode__launch'] }),
      ])
    )

    expect(servers?.[0]?.tools.map((tool) => [tool.name, tool.addedInTurn, tool.removedInTurn])).toEqual([
      ['launch', null, null],
      ['jira_get_issue', null, 1],
    ])
  })

  it('should take a server offering only its sign-in tools as one that needs a sign-in', () => {
    const servers = pluginServers(
      inputs([
        announce(50, {
          added: [
            'mcp__claude_ai_Asana__authenticate',
            'mcp__claude_ai_Asana__complete_authentication',
            'mcp__x__authenticate',
            'mcp__x__run',
          ],
        }),
      ])
    )

    expect(servers?.map((server) => [server.key, server.startState])).toEqual([
      ['claude_ai_Asana', 'needs-sign-in'],
      ['x', 'connected'],
    ])
  })

  it('should take the state stated last before the first request as the state at the start', () => {
    const servers = pluginServers(
      inputs([
        announce(10, { pendingServers: ['claude.ai Figma'] }),
        announce(60, { added: ['mcp__claude_ai_Figma__whoami'], pendingServers: [] }),
      ])
    )

    expect(servers?.map((server) => [server.key, server.startState])).toEqual([['claude_ai_Figma', 'connected']])
  })
})

describe('calledPlugins', () => {
  it('should count each plugin tool a session called, by plugin, the most called first', () => {
    const plugins = calledPlugins([
      { name: 'jira_get_issue', plugin: 'jira', calls: 1, definitionTokens: null },
      { name: 'launch', plugin: 'opencode', calls: 1, definitionTokens: 1200 },
      { name: 'launch', plugin: 'opencode', calls: 1, definitionTokens: 1200 },
    ])

    expect(plugins).toEqual([
      { plugin: 'opencode', tools: [{ name: 'launch', calls: 2, definitionTokens: 1200 }] },
      { plugin: 'jira', tools: [{ name: 'jira_get_issue', calls: 1, definitionTokens: null }] },
    ])
  })
})
