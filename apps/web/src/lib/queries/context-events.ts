import { tokensOf, type ContextEvent } from '../context'
import { brief } from '../format'
import { mainInput } from '../inputs'
import { isPluginFamily, isSkillBody, skillNameOf, SKILL_TOOL, toolName } from '../tools'
import type { ISession, IToolRow } from './session'

const shortPaths = (text: string): string => text.replaceAll(/(?:\/[^\s/]+)+\/([^\s/]+\/[^\s/]+)/gu, '…/$1')

// A ToolSearch result names each tool it loaded; the definition goes into the
// context unseen.
const TOOL_SEARCH = 'toolsearch'
const TOOL_REFERENCE = /\(tool reference: ([^)]+)\)/gu

export const loadedNames = (tool: IToolRow): string[] =>
  tool.name.toLowerCase() === TOOL_SEARCH
    ? [...(tool.output ?? '').matchAll(TOOL_REFERENCE)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
    : []

export const resultKind = (tool: IToolRow): 'builtIn' | 'plugins' | 'skills' => {
  if (tool.name.toLowerCase() === SKILL_TOOL) {
    return 'skills'
  }

  return isPluginFamily(tool.family) ? 'plugins' : 'builtIn'
}

export const contextEvents = (session: ISession): ContextEvent[] =>
  session.messages.flatMap((message): ContextEvent[] => {
    const text = message.text ?? ''

    if (message.actor !== 'assistant') {
      const isSkill = message.actor === 'harness' && isSkillBody(text)

      return [
        ...(message.compactionSummary === null
          ? []
          : [
              {
                type: 'item',
                kind: 'carried',
                label: 'Compaction summary',
                tokens: tokensOf(message.compactionSummary.length),
              } as const,
            ]),
        ...(text === ''
          ? []
          : [
              {
                type: 'item',
                kind: isSkill ? 'skills' : 'prompts',
                label: isSkill ? `skill ${skillNameOf(text)}` : brief(text, 60),
                tokens: tokensOf(text.length),
              } as const,
            ]),
      ]
    }

    const tools = session.toolsByMessage.get(message.id) ?? []

    return [
      ...(message.tokensRead === null
        ? []
        : [{ type: 'request', id: message.id, tokens: message.tokensRead } as const]),
      ...(text === ''
        ? []
        : [{ type: 'item', kind: 'replies', label: 'reply', tokens: tokensOf(text.length) } as const]),
      ...tools.flatMap((tool): ContextEvent[] => [
        {
          type: 'item',
          kind: 'replies',
          label: `${toolName(tool.name)} call`,
          tokens: tokensOf(tool.inputJson.length),
        },
        {
          type: 'item',
          kind: resultKind(tool),
          label: `${toolName(tool.name)} ${shortPaths(mainInput(tool.inputJson, 200))}`.trim(),
          tokens: tokensOf((tool.output ?? '').length),
        },
        ...loadedNames(tool).flatMap((name): ContextEvent[] => {
          const definition = session.definitionTokens.get(name)

          return definition === undefined
            ? []
            : [
                {
                  type: 'item',
                  kind: 'definitions',
                  label: `${toolName(name)} definition`,
                  tokens: definition,
                },
              ]
        }),
      ]),
    ]
  })
