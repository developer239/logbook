import { sumBy } from '../lists'

export interface IToolLoops {
  name: string
  loops: number
}

const TOP_TOOLS = 3

export const loopSummary = (byTool: readonly IToolLoops[]): { shown: IToolLoops[]; others: number } => ({
  shown: byTool.slice(0, TOP_TOOLS),
  others: sumBy(byTool.slice(TOP_TOOLS), (entry) => entry.loops),
})
