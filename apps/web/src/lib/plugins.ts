// Claude Code names a tool mcp__<server>__<tool>, the server's name with every
// character outside [A-Za-z0-9_-] made an underscore. The model sees a deferred
// tool's name only; its definition goes into the context when the server sends
// it at once (surfaced) or a ToolSearch loads it.

import { tokensOf } from './context'
import { sumBy } from './lists'
import { parseMcpName } from './tools'

export interface IToolAnnouncement {
  at: number
  added: string[]
  removed: string[]
  surfaced: string[]
  // Null where the announcement leaves the servers' states out.
  pendingServers: string[] | null
  needsAuthServers: string[] | null
  failedServers: { name: string; error: string | null }[] | null
}

export type ServerState = 'connected' | 'needs-sign-in' | 'failed' | 'connecting'

export interface IPluginTool {
  name: string
  cookbookModule: string | null
  calls: number
  nameTokens: number
  // Null where the harness recorded none: never loaded, or a transcript from before it did.
  definitionTokens: number | null
  // When its definition went into the context: at the start, in the turn a
  // ToolSearch loaded it, or never (the model saw its name only).
  loaded: 'start' | number | null
  addedInTurn: number | null
  removedInTurn: number | null
}

export interface IPluginServer {
  key: string
  name: string
  startState: ServerState
  error: string | null
  tools: IPluginTool[]
}

export interface IPluginInputs {
  announcements: readonly IToolAnnouncement[]
  firstRequestAt: number
  turnAt: (at: number) => number | null
  loadedInTurn: ReadonlyMap<string, number>
  callsOf: (full: string) => number
  definitionOf: (full: string) => number | null
  moduleOf: (full: string) => string | null
}

// Claude Code offers a server that needs a sign-in these two tools in place of
// its own; older versions offered it nothing and listed it among the servers
// that need one.
const SIGN_IN_TOOLS: ReadonlySet<string> = new Set(['authenticate', 'complete_authentication'])

const serverKey = (name: string): string => name.replaceAll(/[^A-Za-z0-9_-]/gu, '_')

interface IToolState {
  server: string
  name: string
  isAtStart: boolean
  isSurfaced: boolean
  addedInTurn: number | null
  removedInTurn: number | null
}

// Null when the session announced no tools: OpenCode, and Claude Code before
// it announced them.
export const pluginServers = (inputs: IPluginInputs): IPluginServer[] | null => {
  if (inputs.announcements.length === 0) {
    return null
  }

  const tools = new Map<string, IToolState>()
  const names = new Map<string, string>()
  const states = new Map<string, { state: ServerState; error: string | null }>()

  for (const announcement of inputs.announcements) {
    const isAtStart = announcement.at <= inputs.firstRequestAt
    const turn = isAtStart ? null : inputs.turnAt(announcement.at)

    for (const full of announcement.added) {
      const mcp = parseMcpName(full)

      if (mcp === null) {
        continue
      }

      const known = tools.get(full)

      if (known === undefined) {
        tools.set(full, {
          server: mcp.server,
          name: mcp.tool,
          isAtStart,
          isSurfaced: false,
          addedInTurn: turn,
          removedInTurn: null,
        })
      } else {
        known.removedInTurn = null
      }
    }

    for (const full of announcement.removed) {
      const known = tools.get(full)

      if (known !== undefined) {
        known.removedInTurn = turn
      }
    }

    for (const full of announcement.surfaced) {
      const known = tools.get(full)

      if (known !== undefined && isAtStart) {
        known.isSurfaced = true
      }
    }

    if (!isAtStart) {
      continue
    }

    // The last state stated before the first request is the state at the start.
    const stated: [string[] | null, ServerState, (name: string) => string | null][] = [
      [announcement.pendingServers, 'connecting', () => null],
      [announcement.needsAuthServers, 'needs-sign-in', () => null],
      [
        announcement.failedServers?.map((server) => server.name) ?? null,
        'failed',
        (name) => announcement.failedServers?.find((server) => server.name === name)?.error ?? null,
      ],
    ]

    for (const [list, state, errorOf] of stated) {
      if (list === null) {
        continue
      }

      for (const [key, known] of states) {
        if (known.state === state && !list.some((name) => serverKey(name) === key)) {
          states.delete(key)
        }
      }

      for (const name of list) {
        names.set(serverKey(name), name)
        states.set(serverKey(name), { state, error: errorOf(name) })
      }
    }
  }

  const servers = new Map<string, IPluginServer>()

  const serverOf = (key: string): IPluginServer => {
    const known = servers.get(key)

    if (known !== undefined) {
      return known
    }

    const stated = states.get(key)
    const server: IPluginServer = {
      key,
      name: names.get(key) ?? key,
      startState: stated?.state ?? 'connected',
      error: stated?.error ?? null,
      tools: [],
    }

    servers.set(key, server)

    return server
  }

  for (const key of states.keys()) {
    serverOf(key)
  }

  for (const [full, tool] of tools) {
    const loadTurn = inputs.loadedInTurn.get(full)
    serverOf(tool.server).tools.push({
      name: tool.name,
      cookbookModule: inputs.moduleOf(full),
      calls: inputs.callsOf(full),
      // The list holds the full name on a line of its own.
      nameTokens: tokensOf(full.length + 1),
      definitionTokens: inputs.definitionOf(full),
      loaded: tool.isSurfaced ? 'start' : (loadTurn ?? null),
      addedInTurn: tool.isAtStart ? null : tool.addedInTurn,
      removedInTurn: tool.removedInTurn,
    })
  }

  return [...servers.values()].map((server) =>
    !states.has(server.key) && server.tools.length > 0 && server.tools.every((tool) => SIGN_IN_TOOLS.has(tool.name))
      ? { ...server, startState: 'needs-sign-in' }
      : server
  )
}

export interface ICalledTool {
  name: string
  calls: number
  definitionTokens: number | null
}

export interface ICalledPlugin {
  // Null for a tool the cookbook no longer has.
  plugin: string | null
  tools: ICalledTool[]
}

export const calledPlugins = (calls: readonly (ICalledTool & { plugin: string | null })[]): ICalledPlugin[] =>
  [...Map.groupBy(calls, (call) => call.plugin)]
    .map(([plugin, ofPlugin]): ICalledPlugin => ({
      plugin,
      tools: [...Map.groupBy(ofPlugin, (call) => call.name)]
        .map(([name, ofTool]): ICalledTool => ({
          name,
          calls: sumBy(ofTool, (call) => call.calls),
          definitionTokens: ofTool[0]?.definitionTokens ?? null,
        }))
        .toSorted((left, right) => right.calls - left.calls),
    }))
    .toSorted((left, right) => sumBy(right.tools, (tool) => tool.calls) - sumBy(left.tools, (tool) => tool.calls))
