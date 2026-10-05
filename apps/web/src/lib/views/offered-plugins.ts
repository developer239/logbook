import { tokensCompact } from '../format'
import { partition, sumBy } from '../lists'
import type { IPluginServer, IPluginTool } from '../plugins'

const isTouched = (tool: IPluginTool): boolean => tool.calls > 0 || tool.loaded !== null

const offerOf = (tools: readonly IPluginTool[]): number => sumBy(tools, (tool) => tool.nameTokens)

interface INameOnly {
  cookbookModule: string | null
  tools: number
  tokens: number
}

const nameOnly = (tools: readonly IPluginTool[]): INameOnly[] =>
  [...Map.groupBy(tools, (tool) => tool.cookbookModule)]
    .map(([cookbookModule, ofPlugin]) => ({ cookbookModule, tools: ofPlugin.length, tokens: offerOf(ofPlugin) }))
    .toSorted((left, right) => right.tokens - left.tokens)

interface IServerBlock extends IPluginServer {
  used: number
  touched: IPluginTool[]
  names: INameOnly[]
  later: number[]
}

interface IQuietServer {
  name: string
  tools: number
  tokens: number
}

export interface IOfferedPlugins {
  blocks: IServerBlock[]
  quiet: IQuietServer[]
  signIn: { names: string[]; tools: number; tokens: number }
  offeredCount: number
  offerTokens: number
  loadedCount: number
  definitions: string
  usedCount: number
  idleCount: number
  failedCount: number
}

export const offeredPlugins = (servers: readonly IPluginServer[]): IOfferedPlugins => {
  const [signIn, others] = partition(servers, (server) => server.startState === 'needs-sign-in')
  const [withBlock, withoutBlock] = partition(
    others,
    (server) => server.tools.some(isTouched) || server.startState !== 'connected'
  )

  const offered = servers.flatMap((server) => server.tools)
  const loaded = offered.filter((tool) => tool.loaded !== null)
  const signInTools = signIn.flatMap((server) => server.tools)

  return {
    blocks: withBlock
      .map((server) => ({
        ...server,
        used: server.tools.filter((tool) => tool.calls > 0).length,
        touched: server.tools.filter(isTouched).toSorted((left, right) => {
          const byCalls = right.calls - left.calls

          return byCalls === 0 ? (right.definitionTokens ?? 0) - (left.definitionTokens ?? 0) : byCalls
        }),
        names: nameOnly(server.tools.filter((tool) => !isTouched(tool))),
        later: server.tools.flatMap((tool) => (tool.addedInTurn === null ? [] : [tool.addedInTurn])),
      }))
      .toSorted((left, right) => {
        const byUsed = right.used - left.used

        return byUsed === 0 ? right.touched.length - left.touched.length : byUsed
      }),
    quiet: withoutBlock
      .map((server) => ({ name: server.name, tools: server.tools.length, tokens: offerOf(server.tools) }))
      .toSorted((left, right) => right.tokens - left.tokens),
    signIn: { names: signIn.map((server) => server.name), tools: signInTools.length, tokens: offerOf(signInTools) },
    offeredCount: offered.length,
    offerTokens: offerOf(offered),
    loadedCount: loaded.length,
    definitions: loaded.every((tool) => tool.definitionTokens === null)
      ? 'unknown'
      : `${tokensCompact(sumBy(loaded, (tool) => tool.definitionTokens ?? 0))}${loaded.some((tool) => tool.definitionTokens === null) ? ' and some unknown' : ''}`,
    usedCount: offered.filter((tool) => tool.calls > 0).length,
    idleCount: loaded.filter((tool) => tool.calls === 0).length,
    failedCount: servers.filter((server) => server.startState === 'failed').length,
  }
}
