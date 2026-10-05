import type { IRecognisedCommand } from '../contract.js'
import { KNOWN_TOOLS } from '../known-tools.js'
import {
  SCRIPT_INTENTS,
  SOURCE_CAPABILITIES,
  type ICommandFile,
  type ISessionScript,
  type ISourceWriter,
  type ScriptFamily,
  type ScriptStep,
  type SourceCapability,
} from '../source-writer/index.js'
import { TOOL_FAMILIES } from '../tool-families.js'

const SHOP = '/home/example/work/shop'
const PROMPT_AT = 1_000
const REPLY_AT = 1_100
const REPLY_END = 1_200
const STEP_AT = 1_300
const STEP_END = 1_400

const SCRIPT_FAMILIES: readonly ScriptFamily[] = [
  ...TOOL_FAMILIES.filter(
    (family): family is Exclude<(typeof TOOL_FAMILIES)[number], 'subagent' | 'skill'> =>
      family !== 'subagent' && family !== 'skill'
  ),
  'mcp',
]

// The families only KNOWN_TOOLS gives a name to: no intent table lists them.
const KNOWN_TOOL_FAMILIES: readonly ScriptFamily[] = SCRIPT_FAMILIES.filter(
  (family) => SCRIPT_INTENTS[family] === undefined && [...KNOWN_TOOLS.values()].includes(family as never)
)

export const firstKnownTool = (family: ScriptFamily): string | undefined =>
  [...KNOWN_TOOLS.entries()].find(([, known]) => known === family)?.[0]

const prompt = (key: string): ScriptStep => ({
  kind: 'prompt',
  key,
  at: PROMPT_AT,
  text: 'check the shop build',
  images: 0,
})

type TReplyStep = Extract<ScriptStep, { kind: 'reply' }>

const reply = (key: string): TReplyStep => ({
  kind: 'reply',
  key,
  at: REPLY_AT,
  endAt: REPLY_END,
  model: 'model-a',
  text: 'Checking it.',
  reasoning: null,
  tokens: null,
  cost: null,
})

const neutralInput = (family: ScriptFamily): { intent: string | null; input: Record<string, unknown> } => {
  const [intent, keys] = Object.entries(SCRIPT_INTENTS[family] ?? {})[0] ?? [null, []]
  return { intent, input: Object.fromEntries(keys.map((key) => [key, 'value'])) }
}

// A valid call of any family, named and served as the family requires.
const callOf = (
  key: string,
  family: ScriptFamily,
  fields: Partial<Extract<ScriptStep, { kind: 'call' }>> = {}
): ScriptStep => ({
  kind: 'call',
  key,
  family,
  ...neutralInput(family),
  tool: family === 'mcp' || family === 'other' ? 'probe' : null,
  server: family === 'mcp' ? 'tools' : null,
  status: 'completed',
  result: 'ok',
  startAt: STEP_AT,
  endAt: STEP_END,
  ...fields,
})

// A script that opens with a prompt and a reply, then the given steps.
const scriptOf = (key: string, steps: readonly ScriptStep[], fields: Partial<ISessionScript> = {}): ISessionScript => ({
  key,
  projectDir: SHOP,
  title: null,
  agent: null,
  gitBranch: null,
  isScripted: false,
  harnessVersion: null,
  steps: [prompt(`${key}-p`), reply(`${key}-r`), ...steps],
  ...fields,
})

const event = (key: string, value: Extract<ScriptStep, { kind: 'event' }>['event']): ScriptStep => ({
  kind: 'event',
  key,
  at: STEP_AT,
  event: value,
})

const spawnOf = (key: string, child: ISessionScript): ScriptStep => ({
  kind: 'spawn',
  key,
  agentType: 'explore',
  prompt: 'look around',
  child,
  result: 'done',
  startAt: STEP_AT,
  endAt: STEP_END,
})

export interface IRefusal {
  // What the writer lacks.
  readonly lacks: string
  readonly script: ISessionScript
  // The key the refusal must name.
  readonly key: string
}

// One script per capability, each using only that capability; the family of a rejected call is one the writer has.
const capabilityScript = (capability: SourceCapability, family: ScriptFamily): IRefusal => {
  const key = `needs-${capability}`
  const step = `${key}-step`
  const scripts: Readonly<Record<SourceCapability, () => IRefusal>> = {
    'git-branch': () => ({ lacks: capability, script: scriptOf(key, [], { gitBranch: 'main' }), key }),
    'session-agent': () => ({ lacks: capability, script: scriptOf(key, [], { agent: 'build' }), key }),
    'scripted': () => ({ lacks: capability, script: scriptOf(key, [], { isScripted: true }), key }),
    'image': () => ({
      lacks: capability,
      script: {
        ...scriptOf(key, []),
        steps: [{ kind: 'prompt', key: step, at: PROMPT_AT, text: 'see the screenshot', images: 1 }],
      },
      key: step,
    }),
    'reported-cost': () => ({
      lacks: capability,
      script: { ...scriptOf(key, []), steps: [prompt(`${key}-p`), { ...reply(step), cost: 0.01 }] },
      key: step,
    }),
    'mcp-server': () => ({ lacks: capability, script: scriptOf(key, [callOf(step, 'mcp')]), key: step }),
    'typed-command': () => ({
      lacks: capability,
      script: scriptOf(key, [{ kind: 'command', key: step, at: STEP_AT, name: 'ship', arguments: 'now', body: null }]),
      key: step,
    }),
    'template-command': () => ({
      lacks: capability,
      script: scriptOf(key, [
        { kind: 'command', key: step, at: STEP_AT, name: 'ship', arguments: 'now', body: 'Ship now.' },
      ]),
      key: step,
    }),
    'nested-subagent': () => ({
      lacks: capability,
      script: scriptOf(key, [
        spawnOf(`${key}-outer`, scriptOf(`${key}-child`, [spawnOf(step, scriptOf(`${key}-grandchild`, []))])),
      ]),
      key: step,
    }),
    'model-switch': () => ({
      lacks: capability,
      script: scriptOf(key, [event(step, { type: 'model-switch', model: 'model-b', previous: 'model-a' })]),
      key: step,
    }),
    'agent-switch': () => ({
      lacks: capability,
      script: scriptOf(key, [event(step, { type: 'agent-switch', agent: 'plan' })]),
      key: step,
    }),
    'idle-event': () => ({
      lacks: capability,
      script: scriptOf(key, [event(step, { type: 'idle', outcome: 'done' })]),
      key: step,
    }),
    'tools-offered': () => ({
      lacks: capability,
      script: scriptOf(key, [event(step, { type: 'tools-offered', added: ['probe'], removed: [], failedServers: [] })]),
      key: step,
    }),
    'tools-loaded': () => ({
      lacks: capability,
      script: scriptOf(key, [
        event(step, { type: 'tools-loaded', tools: [{ name: 'probe', description: 'Probe.', inputSchema: {} }] }),
      ]),
      key: step,
    }),
    'interrupt': () => ({
      lacks: capability,
      script: scriptOf(key, [{ kind: 'interrupt', key: step, at: STEP_AT }]),
      key: step,
    }),
    'tool-reject': () => ({
      lacks: capability,
      script: scriptOf(key, [callOf(step, family, { status: 'rejected', result: null })]),
      key: step,
    }),
  }
  return scripts[capability]()
}

// A script for each capability and family the writer does not declare.
export const refusalsFor = (writer: ISourceWriter): IRefusal[] => {
  const [family = 'other'] = [...writer.families]
  return [
    ...SOURCE_CAPABILITIES.filter((capability) => !writer.capabilities.has(capability)).map((capability) =>
      capabilityScript(capability, family)
    ),
    ...SCRIPT_FAMILIES.filter((candidate) => !writer.families.has(candidate)).map((candidate) => ({
      lacks: `the family ${candidate}`,
      script: scriptOf(`needs-${candidate}`, [callOf(`needs-${candidate}-call`, candidate)]),
      key: `needs-${candidate}-call`,
    })),
  ]
}

// A call of each family only KNOWN_TOOLS names that the writer records, written behind a server when it records them.
export const knownToolScripts = (writer: ISourceWriter): ISessionScript[] =>
  KNOWN_TOOL_FAMILIES.filter((family) => writer.families.has(family)).map((family) =>
    scriptOf(`known-${family}`, [
      callOf(`known-${family}-call`, family, {
        server: writer.capabilities.has('mcp-server') ? 'tools' : null,
        input: {},
      }),
    ])
  )

export const SHIP_CHECK = 'ship-check'
const SHIP_CHECK_BODY = 'Check that the project builds, its tests pass and its changelog names this release: $ARGUMENTS'

export const projectCommandFile: ICommandFile = { name: SHIP_CHECK, body: SHIP_CHECK_BODY, projectDir: SHOP }

// Two sessions, in `shop` and in `billing`, each running the command once.
export const projectCommandScripts = (writer: ISourceWriter): ISessionScript[] =>
  [SHOP, '/home/example/work/billing'].map((projectDir, index) => ({
    ...scriptOf(`ship-check-${String(index + 1)}`, []),
    projectDir,
    steps: [
      {
        kind: 'command',
        key: `ship-check-${String(index + 1)}-command`,
        at: PROMPT_AT,
        name: SHIP_CHECK,
        arguments: '2.3.0',
        body: writer.capabilities.has('template-command') ? SHIP_CHECK_BODY : null,
      },
    ],
  }))

// The answer a command step's prompt must get: with a file of its name written globally or for its session's
// project, the command with a file; without one, a typed command for a writer that records typed commands, and none
// for one that does not, because a template command is known only from its file.
export const expectedAnswer = (
  writer: ISourceWriter,
  name: string,
  sessionDir: string,
  files: readonly ICommandFile[]
): IRecognisedCommand | null => {
  const isTyped = writer.capabilities.has('typed-command')
  const hasFile = files.some(
    (file) => file.name === name && (file.projectDir === null || file.projectDir === sessionDir)
  )
  if (hasFile) {
    return { command: name, source: isTyped ? 'typed' : 'template', hasFile: true }
  }
  return isTyped ? { command: name, source: 'typed', hasFile: false } : null
}
