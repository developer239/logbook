import {
  calledPlugins,
  pluginServers,
  type ICalledPlugin,
  type IPluginServer,
  type IToolAnnouncement,
} from '../plugins'
import { all } from '../warehouse'
import { loadedNames } from './context-events'
import { messageOf, sessionOf, type ISession, type ISessionCache } from './session'

export type PluginsView =
  | { offers: 'recorded'; servers: IPluginServer[] }
  // A session that recorded no tools-offered event: only the plugin tools it called are known.
  | { offers: 'unknown'; plugins: ICalledPlugin[]; definitions: 'recorded' | 'unrecorded' }

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

export const sessionPlugins = (cache: ISessionCache, sessionId: string): PluginsView => {
  const session = sessionOf(cache, sessionId)
  const announcements = all<{ at: number; data: string }>(
    `SELECT at, data_json AS data FROM event WHERE session_id = ? AND kind = 'tools-offered' ORDER BY at`,
    sessionId
  ).map((row): IToolAnnouncement => ({ at: row.at, ...(JSON.parse(row.data) as Omit<IToolAnnouncement, 'at'>) }))

  const servers = pluginServers({
    announcements,
    firstRequestAt:
      session.messages.find((message) => message.actor === 'assistant' && message.tokensRead !== null)?.createdAt ??
      Number.POSITIVE_INFINITY,
    turnAt: (at) => turnAt(session, at),
    loadedInTurn: loadedInTurn(session),
    callsOf: (full) => session.callsByName.get(full) ?? 0,
    definitionOf: (full) => session.definitionTokens.get(full) ?? null,
  })

  if (servers !== null) {
    return { offers: 'recorded', servers }
  }

  return {
    offers: 'unknown',
    plugins: calledPlugins(
      session.tools.flatMap((tool) =>
        tool.server === null
          ? []
          : [
              {
                name: tool.bareName,
                plugin: tool.server,
                calls: 1,
                definitionTokens: session.definitionTokens.get(tool.name) ?? null,
              },
            ]
      )
    ),
    // Whether the session recorded the definitions it loaded, by its own events.
    definitions: session.definitionTokens.size > 0 ? 'recorded' : 'unrecorded',
  }
}
