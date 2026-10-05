import { tokensOf } from '../context'
import { typical } from '../format'
import { sum } from '../lists'
import type { IRange } from '../range'
import { CALL_AT } from '../sql'
import { cookbookTool, isCookbookFamily, normalName, skillNameOf, SKILL_BODY, SKILL_TOOL, toolName } from '../tools'
import { all } from '../warehouse'
import { type IOfferedTool, offeredTools } from './tools'

// The warehouse counts tokens per model request, not per call, so a call's cost
// is estimated from the text it puts in the context: what the model wrote to
// call it and what came back. A skill is counted by the text it loads, from the
// skill tool (OpenCode) or the message Claude Code injects, which a slash
// command loads as well.

export interface IToolSource {
  kind: 'plugin' | 'built-in' | 'skills'
  name: string
}

export interface IToolTokens {
  name: string
  source: IToolSource
  calls: number
  typicalTokens: number | null
  totalTokens: number
  // Null for a tool the cookbook does not offer.
  definitionTokens: number | null
  isRetired: boolean
}

const BUILT_IN: IToolSource = { kind: 'built-in', name: 'Built in' }
const SKILLS: IToolSource = { kind: 'skills', name: 'Skills' }

const sourceOf = (family: string, name: string): IToolSource => {
  if (isCookbookFamily(family)) {
    return { kind: 'plugin', name: toolName(name).split('_')[0] ?? toolName(name) }
  }

  if (family.startsWith('mcp:')) {
    return { kind: 'plugin', name: family.slice('mcp:'.length) }
  }

  return BUILT_IN
}

interface IGroup {
  name: string
  source: IToolSource
  sizes: number[]
  extra: number
  tool: IOfferedTool | undefined
  isCookbook: boolean
}

export const toolTokens = (range: IRange): IToolTokens[] => {
  const offered = offeredTools()
  const calls = all<{ name: string; family: string; harness: string; skill: string | null; chars: number }>(
    `SELECT tc.name, tc.family, (SELECT s.harness FROM session s WHERE s.id = tc.session_id) AS harness,
       CASE WHEN lower(tc.name) = '${SKILL_TOOL}' THEN COALESCE(json_extract(tc.input_json, '$.skill'),
         json_extract(tc.input_json, '$.name'), json_extract(tc.input_json, '$.id')) END AS skill,
       length(tc.input_json) + COALESCE((SELECT SUM(length(p.text)) FROM part p
         WHERE p.tool_call_id = tc.id AND p.kind = 'tool_result'), 0) AS chars
     FROM tool_call tc WHERE ${CALL_AT} >= ? AND ${CALL_AT} < ?`,
    range.from,
    range.to
  )

  const bodies = all<{ head: string; chars: number }>(
    `SELECT substr(p.text, 1, instr(p.text || char(10), char(10)) - 1) AS head, length(p.text) AS chars
     FROM part p JOIN message m ON m.id = p.message_id
     WHERE m.actor = 'harness' AND p.kind = 'text' AND p.text LIKE '${SKILL_BODY}%'
       AND m.created_at >= ? AND m.created_at < ?`,
    range.from,
    range.to
  )

  const groups = new Map<string, IGroup>()

  const add = (key: string, group: Omit<IGroup, 'sizes' | 'extra'>): IGroup => {
    const known = groups.get(key) ?? { ...group, sizes: [], extra: 0 }
    groups.set(key, known)
    return known
  }

  for (const call of calls) {
    if (call.skill === null) {
      const tool = cookbookTool(offered, call.harness, call.name)
      const source =
        tool === undefined ? sourceOf(call.family, call.name) : { kind: 'plugin' as const, name: tool.module }

      // A cookbook tool is one tool whichever harness calls it, so it is told by
      // its name without the MCP server's; another server may name a tool alike.
      const isCookbookCall = tool !== undefined || isCookbookFamily(call.family)

      add(`tool:${isCookbookCall ? normalName(call.name) : call.name.toLowerCase()}`, {
        name: toolName(call.name),
        source,
        tool,
        isCookbook: isCookbookFamily(call.family),
      }).sizes.push(call.chars)
    } else if (call.harness === 'claude-code') {
      // A Claude Code skill call only announces the skill; its text is the
      // message after it, counted below.
      add(`skill:${call.skill}`, { name: call.skill, source: SKILLS, tool: undefined, isCookbook: false }).extra +=
        call.chars
    } else {
      add(`skill:${call.skill}`, { name: call.skill, source: SKILLS, tool: undefined, isCookbook: false }).sizes.push(
        call.chars
      )
    }
  }

  for (const body of bodies) {
    const name = skillNameOf(body.head)
    add(`skill:${name}`, { name, source: SKILLS, tool: undefined, isCookbook: false }).sizes.push(body.chars)
  }

  for (const [key, tool] of offered) {
    add(`tool:${key}`, { name: tool.name, source: { kind: 'plugin', name: tool.module }, tool, isCookbook: true })
  }

  return [...groups.values()]
    .map((group): IToolTokens => ({
      name: group.name,
      source: group.source,
      calls: group.sizes.length,
      typicalTokens: group.sizes.length === 0 ? null : tokensOf(typical(group.sizes)),
      totalTokens: tokensOf(sum(group.sizes) + group.extra),
      definitionTokens: group.tool === undefined ? null : tokensOf(group.tool.definitionChars),
      isRetired: group.isCookbook && group.tool === undefined,
    }))
    .filter((row) => row.calls > 0 || row.definitionTokens !== null)
    .toSorted((left, right) => {
      const byTotal = right.totalTokens - left.totalTokens

      return byTotal === 0 ? (right.definitionTokens ?? 0) - (left.definitionTokens ?? 0) : byTotal
    })
}
