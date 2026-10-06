import { tokensOf, type ContextEvent } from '../context'
import { brief } from '../format'
import { mainInput } from '../inputs'
import type { ISession, ISkillLoad, IToolRow } from './session'

const shortPaths = (text: string): string => text.replaceAll(/(?:\/[^\s/]+)+\/([^\s/]+\/[^\s/]+)/gu, '…/$1')

// A tool search's result names each tool it loaded; the definition goes into
// the context unseen.
const TOOL_REFERENCE = /\(tool reference: ([^)]+)\)/gu

export const loadedNames = (tool: IToolRow): string[] =>
  tool.family === 'tool-search'
    ? [...(tool.output ?? '').matchAll(TOOL_REFERENCE)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
    : []

// A skill call's result carries the skill; a call that recorded a server is a plugin's.
const resultKind = (tool: IToolRow): 'builtIn' | 'plugins' | 'skills' => {
  if (tool.family === 'skill') {
    return 'skills'
  }

  return tool.server === null ? 'builtIn' : 'plugins'
}

// The skill a harness message carries: the harness recorded a skill load at the message's own time, from the same
// source line.
const skillOf = (session: ISession, at: number): ISkillLoad | undefined =>
  session.skillLoads.find((load) => load.at === at)

export const contextEvents = (session: ISession): ContextEvent[] =>
  session.messages.flatMap((message): ContextEvent[] => {
    const text = message.text ?? ''

    if (message.actor !== 'assistant') {
      const skill = message.actor === 'harness' ? skillOf(session, message.createdAt) : undefined

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
                kind: skill === undefined ? 'prompts' : 'skills',
                label: skill === undefined ? brief(text, 60) : `skill ${skill.name}`,
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
          label: `${tool.bareName} call`,
          tokens: tokensOf(tool.inputJson.length),
        },
        {
          type: 'item',
          kind: resultKind(tool),
          label: `${tool.bareName} ${shortPaths(mainInput(tool.inputJson, 200))}`.trim(),
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
                  label: `${name} definition`,
                  tokens: definition,
                },
              ]
        }),
      ]),
    ]
  })
