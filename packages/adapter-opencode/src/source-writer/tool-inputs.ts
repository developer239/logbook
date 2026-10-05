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

// Each intent of a family the adapter's table lists, as the OpenCode 2.0 tool and input keys that record it. OpenCode
// 2.0 has no todo or tool-search tool.
const INTENT_TOOLS: Readonly<Record<string, IIntentTool>> = {
  'shell:run': { name: 'shell', input: ({ command }) => ({ command }) },
  'read:read': { name: 'read', input: ({ path }) => ({ filePath: path }) },
  'edit:edit': {
    name: 'edit',
    input: ({ path, old, new: replacement }) => ({ filePath: path, oldString: old, newString: replacement }),
  },
  'edit:write': { name: 'write', input: ({ path, content }) => ({ filePath: path, content }) },
  'search:text': { name: 'grep', input: ({ pattern, path }) => ({ pattern, path }) },
  'search:files': { name: 'glob', input: ({ pattern }) => ({ pattern }) },
  'web:fetch': { name: 'webfetch', input: ({ url }) => ({ url }) },
  'web:search': { name: 'websearch', input: ({ query }) => ({ query }) },
  'question:ask': { name: 'question', input: ({ question }) => ({ questions: [{ question }] }) },
}

// The families only KNOWN_TOOLS names here; their calls are written bare, with the script's input as given.
const KNOWN_TOOL_FAMILIES: ReadonlySet<string> = new Set(['wait', 'dispatch'])

export const unsupported = (key: string, reason: string): LogBookError =>
  new LogBookError(`Script ${key}: ${reason}.`, SOURCE_WRITER_ERROR_CODES.WRITER_SCRIPT_UNSUPPORTED)

// The neutral keys a script gave, in the order the tool writes them; a key the script left out stays out.
const present = (input: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))

// The first KNOWN_TOOLS name of a family, read at run time so no writer source names an add-on tool.
const knownToolOf = (family: string): string | undefined => [...KNOWN_TOOLS].find(([, known]) => known === family)?.[0]

const namedCall = (step: TCallStep): { name: string; input: Record<string, unknown> } => {
  if (KNOWN_TOOL_FAMILIES.has(step.family)) {
    const known = knownToolOf(step.family)
    if (known === undefined) {
      throw unsupported(step.key, `no known tool has the family ${step.family}`)
    }
    return { name: known, input: { ...step.input } }
  }
  if (step.family === 'other') {
    return { name: String(step.tool), input: { ...step.input } }
  }
  const intent = INTENT_TOOLS[`${step.family}:${String(step.intent)}`]
  if (intent === undefined) {
    throw unsupported(step.key, `OpenCode has no tool for the ${step.family} intent ${String(step.intent)}`)
  }
  return { name: step.tool ?? intent.name, input: present(intent.input(step.input)) }
}

// The tool name and input a call is recorded with. The family the adapter's lookup gives the name must be the
// script's, so a call never imports as another family.
export const openCodeToolCall = (step: TCallStep): { name: string; input: Record<string, unknown> } => {
  const call = namedCall(step)
  const { family } = toolNameOf(call.name)
  if (family !== step.family) {
    throw unsupported(step.key, `the tool ${call.name} imports as ${family}, not ${step.family}`)
  }
  return call
}
