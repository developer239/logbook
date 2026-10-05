import { partition, sumBy } from '../lists'
import type { IToolSource, IToolTokens } from '../queries/tool-tokens'

export interface IToolGroup {
  source: IToolSource
  calls: number
  totalTokens: number
  unusedTools: number
  retiredTools: number
  definitionTokens: number
  tools: IToolTokens[]
}

export const toolGroups = (rows: readonly IToolTokens[]): IToolGroup[] =>
  [...Map.groupBy(rows, (row) => `${row.source.kind}:${row.source.name}`).values()]
    .flatMap((tools): IToolGroup[] => {
      const [first] = tools

      return first === undefined
        ? []
        : [
            {
              source: first.source,
              calls: sumBy(tools, (tool) => tool.calls),
              totalTokens: sumBy(tools, (tool) => tool.totalTokens),
              unusedTools: tools.filter((tool) => tool.calls === 0).length,
              retiredTools: tools.filter((tool) => tool.isRetired).length,
              definitionTokens: sumBy(tools, (tool) => tool.definitionTokens ?? 0),
              tools,
            },
          ]
    })
    .toSorted((left, right) => {
      const byTotal = right.totalTokens - left.totalTokens

      return byTotal === 0 ? right.definitionTokens - left.definitionTokens : byTotal
    })

const SHOWN = 10

// 1 where there are no tools, so a bar is never divided by nothing.
export const mostTotal = (rows: readonly IToolTokens[]): number => Math.max(1, ...rows.map((row) => row.totalTokens))

export const cardTools = (rows: readonly IToolTokens[]): { shown: IToolTokens[]; called: number; most: number } => {
  const used = rows.filter((row) => row.calls > 0)

  return { shown: used.slice(0, SHOWN), called: used.length, most: mostTotal(used) }
}

// Plugins first, their bars against each other; the harness's own tools and
// skills cost far more and would flatten them, so they come after, unbarred.
export const pluginGroups = (rows: readonly IToolTokens[]): { groups: IToolGroup[]; mostPlugin: number } => {
  const [plugins, rest] = partition(toolGroups(rows), (group) => group.source.kind === 'plugin')

  return { groups: [...plugins, ...rest], mostPlugin: Math.max(0, ...plugins.map((group) => group.totalTokens)) }
}
