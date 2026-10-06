import { tokensOf } from '../context'
import { typical } from '../format'
import { sum } from '../lists'
import type { IRange } from '../range'
import { CALL_AT } from '../sql'
import { all } from '../warehouse'

// The warehouse counts tokens per model request, not per call, so a call's cost
// is estimated from the text it puts in the context: what the model wrote to
// call it and what came back. A skill is counted by the text each load put in
// the context, as its skill-loaded event recorded it, and by the request of the
// call that loaded it. A tool's definition size is what the sessions in the
// range recorded loading for it.

export interface IToolSource {
  kind: 'plugin' | 'built-in' | 'skills'
  name: string
}

export interface IToolTokens {
  name: string
  source: IToolSource
  calls: number
  typicalTokens: number
  totalTokens: number
  // Null for a tool no session recorded a definition for.
  definitionTokens: number | null
}

const BUILT_IN: IToolSource = { kind: 'built-in', name: 'Built in' }
const SKILLS: IToolSource = { kind: 'skills', name: 'Skills' }

// A call that recorded an MCP server groups under it; every other call is the harness's own.
const sourceOf = (server: string | null): IToolSource => (server === null ? BUILT_IN : { kind: 'plugin', name: server })

interface IGroup {
  name: string
  source: IToolSource
  sizes: number[]
  extra: number
  definitionChars: number | null
}

// The largest definition each tool was loaded with, by its full name in lower case.
const definitionSizes = (range: IRange): Map<string, number> => {
  const loaded = all<{ name: string; chars: number }>(
    `SELECT lower(json_extract(t.value, '$.name')) AS name, MAX(json_extract(t.value, '$.chars')) AS chars
     FROM event e, json_each(e.data_json, '$.tools') t
     WHERE e.kind = 'tools-loaded' AND e.at >= ? AND e.at < ? GROUP BY 1`,
    range.from,
    range.to
  )

  return new Map(loaded.map((tool) => [tool.name, tool.chars]))
}

const largest = (known: number | null, size: number | undefined): number | null =>
  size === undefined ? known : Math.max(known ?? 0, size)

interface ICallRow {
  id: string
  name: string
  bareName: string
  server: string | null
  requestChars: number
  chars: number
}

interface ISkillLoad {
  name: string
  chars: number
  toolCallId: string | null
}

export const toolTokens = (range: IRange): IToolTokens[] => {
  const definitions = definitionSizes(range)
  const calls = all<ICallRow>(
    `SELECT tc.id, tc.name, tc.bare_name AS bareName, tc.server, length(tc.input_json) AS requestChars,
       length(tc.input_json) + COALESCE((SELECT SUM(length(p.text)) FROM part p
         WHERE p.tool_call_id = tc.id AND p.kind = 'tool_result'), 0) AS chars
     FROM tool_call tc WHERE ${CALL_AT} >= ? AND ${CALL_AT} < ?`,
    range.from,
    range.to
  )

  const loads = all<ISkillLoad>(
    `SELECT json_extract(e.data_json, '$.name') AS name, json_extract(e.data_json, '$.chars') AS chars,
       json_extract(e.data_json, '$.toolCallId') AS toolCallId
     FROM event e WHERE e.kind = 'skill-loaded' AND e.at >= ? AND e.at < ?`,
    range.from,
    range.to
  )

  const groups = new Map<string, IGroup>()

  const add = (key: string, group: Omit<IGroup, 'sizes' | 'extra' | 'definitionChars'>): IGroup => {
    const known = groups.get(key) ?? { ...group, sizes: [], extra: 0, definitionChars: null }
    groups.set(key, known)
    return known
  }

  // A call that loaded a skill is part of that load, counted with the skill below.
  const loadingCalls = new Set(loads.flatMap((load) => (load.toolCallId === null ? [] : [load.toolCallId])))
  const requestOf = new Map(calls.map((call) => [call.id, call.requestChars]))

  for (const call of calls.filter((candidate) => !loadingCalls.has(candidate.id))) {
    // One tool by its server and its name without the server's prefix, whatever case a harness gives it.
    const group = add(`tool:${call.server ?? ''}:${call.bareName.toLowerCase()}`, {
      name: call.bareName,
      source: sourceOf(call.server),
    })

    group.sizes.push(call.chars)
    group.definitionChars = largest(group.definitionChars, definitions.get(call.name.toLowerCase()))
  }

  for (const load of loads) {
    const group = add(`skill:${load.name}`, { name: load.name, source: SKILLS })

    group.sizes.push(load.chars)
    group.extra += load.toolCallId === null ? 0 : (requestOf.get(load.toolCallId) ?? 0)
  }

  return [...groups.values()]
    .filter((group) => group.sizes.length > 0)
    .map((group): IToolTokens => ({
      name: group.name,
      source: group.source,
      calls: group.sizes.length,
      typicalTokens: tokensOf(typical(group.sizes)),
      totalTokens: tokensOf(sum(group.sizes) + group.extra),
      definitionTokens: group.definitionChars === null ? null : tokensOf(group.definitionChars),
    }))
    .toSorted((left, right) => {
      const byTotal = right.totalTokens - left.totalTokens

      return byTotal === 0 ? (right.definitionTokens ?? 0) - (left.definitionTokens ?? 0) : byTotal
    })
}
