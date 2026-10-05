import { tokensOf } from '../context'
import {
  calledPlugins,
  pluginServers,
  type ICalledPlugin,
  type IPluginServer,
  type IToolAnnouncement,
} from '../plugins'
import { cookbookTool, parseMcpName, toolName } from '../tools'
import { all } from '../warehouse'
import { loadedNames, resultKind } from './context-events'
import { messageOf, sessionOf, type ISession, type SessionCache } from './session'
import { offeredTools, type IOfferedTool } from './tools'

export type PluginsView =
  | { offers: 'recorded'; servers: IPluginServer[] }
  // OpenCode, and Claude Code before it announced the tools it offers.
  | { offers: 'unknown'; plugins: ICalledPlugin[]; definitions: 'recorded' | 'today' }

const turnAt = (session: ISession, at: number): number | null => {
  const turn = session.turns.findLast((row) => row.startedAt <= at)
  return turn === undefined ? null : turn.seq + 1
}

const loadedInTurn = (session: ISession): Map<string, number> => {
  const turns = new Map<string, number>()

  for (const tool of session.tools.toSorted((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0))) {
    for (const name of loadedNames(tool)) {
      const turn = turnAt(session, messageOf(session, tool.messageId).createdAt)

      if (turn === null) {
        throw new Error(`ToolSearch call ${tool.id} sits outside every turn of ${session.id}`)
      }

      if (!turns.has(name)) {
        turns.set(name, turn)
      }
    }
  }

  return turns
}

export const sessionPlugins = (cache: SessionCache, sessionId: string): PluginsView => {
  const session = sessionOf(cache, sessionId)
  const offered = offeredTools()
  const announcements = all<{ at: number; data: string }>(
    `SELECT at, data_json AS data FROM event WHERE session_id = ? AND kind = 'tools-offered' ORDER BY at`,
    sessionId
  ).map((row): IToolAnnouncement => ({ at: row.at, ...(JSON.parse(row.data) as Omit<IToolAnnouncement, 'at'>) }))

  const isClaudeCode = session.harness === 'claude-code'
  const cookbook = (name: string): IOfferedTool | undefined => cookbookTool(offered, session.harness, name)

  const servers = pluginServers({
    announcements,
    firstRequestAt:
      session.messages.find((message) => message.actor === 'assistant' && message.tokensRead !== null)?.createdAt ??
      Number.POSITIVE_INFINITY,
    turnAt: (at) => turnAt(session, at),
    loadedInTurn: loadedInTurn(session),
    callsOf: (full) => session.callsByName.get(full) ?? 0,
    definitionOf: (full) => session.definitionTokens.get(full) ?? null,
    moduleOf: (full) => cookbook(full)?.module ?? null,
  })

  if (servers !== null) {
    return { offers: 'recorded', servers }
  }

  return {
    offers: 'unknown',
    plugins: calledPlugins(
      session.tools
        .filter((tool) => resultKind(tool) === 'plugins')
        .map((tool) => {
          const known = cookbook(tool.name)

          return {
            name: toolName(tool.name),
            plugin: known?.module ?? parseMcpName(tool.name)?.server ?? null,
            calls: 1,
            definitionTokens: isClaudeCode
              ? (session.definitionTokens.get(tool.name) ?? null)
              : known === undefined
                ? null
                : tokensOf(known.definitionChars),
          }
        })
    ),
    definitions: isClaudeCode ? 'recorded' : 'today',
  }
}
