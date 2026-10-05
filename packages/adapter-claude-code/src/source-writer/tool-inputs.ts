import { KNOWN_TOOLS } from '@log-book/adapter-api'
import { SOURCE_WRITER_ERROR_CODES, type ScriptStep } from '@log-book/adapter-api/source-writer'
import { LogBookError } from '@log-book/core'
import { toolNameOf } from '../families.js'

type TCallStep = Extract<ScriptStep, { kind: 'call' }>
type TInput = Readonly<Record<string, unknown>>

interface IIntentTool {
  name: string
  input: (input: TInput) => Record<string, unknown>
}

// Each intent of a family the adapter's table lists, as the Claude Code tool and input keys that record it.
const INTENT_TOOLS: Readonly<Record<string, IIntentTool>> = {
  'shell:run': { name: 'Bash', input: ({ command }) => ({ command }) },
  'read:read': { name: 'Read', input: ({ path }) => ({ file_path: path }) },
  'edit:edit': {
    name: 'Edit',
    input: ({ path, old, new: replacement }) => ({ file_path: path, old_string: old, new_string: replacement }),
  },
  'edit:write': { name: 'Write', input: ({ path, content }) => ({ file_path: path, content }) },
  'search:text': { name: 'Grep', input: ({ pattern, path }) => ({ pattern, path }) },
  'search:files': { name: 'Glob', input: ({ pattern }) => ({ pattern }) },
  'web:fetch': { name: 'WebFetch', input: ({ url }) => ({ url }) },
  'web:search': { name: 'WebSearch', input: ({ query }) => ({ query }) },
  'todo:update': { name: 'TodoWrite', input: ({ items }) => ({ todos: items }) },
  'question:ask': { name: 'AskUserQuestion', input: ({ question }) => ({ questions: [{ question }] }) },
  'tool-search:load': { name: 'ToolSearch', input: ({ query }) => ({ query }) },
  'wait:output': { name: 'TaskOutput', input: ({ task }) => ({ task_id: task }) },
}

const unsupported = (key: string, reason: string): LogBookError =>
  new LogBookError(`Script ${key}: ${reason}.`, SOURCE_WRITER_ERROR_CODES.WRITER_SCRIPT_UNSUPPORTED)

// The neutral keys a script gave, in the order the tool writes them; a key the script left out stays out.
const present = (input: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))

// The first KNOWN_TOOLS name of a family, read at run time so no writer source names an add-on tool.
const knownToolOf = (family: string): string | undefined => [...KNOWN_TOOLS].find(([, known]) => known === family)?.[0]

const namedCall = (step: TCallStep): { name: string; input: Record<string, unknown> } => {
  if (step.family === 'mcp') {
    return { name: `mcp__${String(step.server)}__${String(step.tool)}`, input: { ...step.input } }
  }
  if (step.family === 'dispatch') {
    const known = knownToolOf('dispatch')
    if (known === undefined || step.server === null) {
      throw unsupported(step.key, 'Claude Code calls a dispatch tool only behind a server')
    }
    return { name: `mcp__${step.server}__${known}`, input: { ...step.input } }
  }
  if (step.family === 'other') {
    return { name: String(step.tool), input: { ...step.input } }
  }
  const intent = INTENT_TOOLS[`${step.family}:${String(step.intent)}`]
  if (intent === undefined) {
    throw unsupported(step.key, `Claude Code has no tool for the ${step.family} intent ${String(step.intent)}`)
  }
  return { name: step.tool ?? intent.name, input: present(intent.input(step.input)) }
}

// The tool name and input a call is recorded with. The family the adapter's lookup gives the name must be the
// script's, so a call never imports as another family.
export const claudeToolCall = (step: TCallStep): { name: string; input: Record<string, unknown> } => {
  const call = namedCall(step)
  const { family, server } = toolNameOf(call.name)
  const expected = step.family === 'mcp' ? `mcp:${String(step.server)}` : step.family
  if (family !== expected || (step.server !== null && server !== step.server)) {
    throw unsupported(step.key, `the tool ${call.name} imports as ${family}, not ${expected}`)
  }
  return call
}
