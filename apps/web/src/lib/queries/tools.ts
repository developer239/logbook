import { all } from '../warehouse'

export interface IOfferedTool {
  module: string
  name: string
  definitionChars: number
}

export const offeredTools = (): Map<string, IOfferedTool> =>
  new Map(
    all<IOfferedTool>(
      'SELECT module, name, length(name) + length(description) + length(input_schema) AS definitionChars FROM tool'
    ).map((tool) => [tool.name.toLowerCase(), tool])
  )
