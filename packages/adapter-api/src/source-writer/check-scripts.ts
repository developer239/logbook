import { LogBookError } from '@log-book/core'
import {
  isScriptProjectDir,
  SCRIPT_HOME,
  SOURCE_WRITER_ERROR_CODES,
  type ICommandFile,
  type ISessionScript,
  type ISourceWriter,
  type ScriptEvent,
  type ScriptStep,
  type SourceCapability,
} from './contract.js'
import { SCRIPT_INTENTS } from './intents.js'

type TCallStep = Extract<ScriptStep, { kind: 'call' }>
type TReplyStep = Extract<ScriptStep, { kind: 'reply' }>

const HARNESS_VERSION = /^(?<minor>\d+\.\d+)(?:\.\d+)?$/u
const PROJECT_DIR_RULE = `is not an absolute path strictly below ${SCRIPT_HOME} without . or .. segments or a trailing /`

const invalid = (key: string, reason: string): LogBookError =>
  new LogBookError(`Script ${key}: ${reason}.`, SOURCE_WRITER_ERROR_CODES.WRITER_SCRIPT_INVALID)

const unsupported = (key: string, reason: string): LogBookError =>
  new LogBookError(`Script ${key}: ${reason}.`, SOURCE_WRITER_ERROR_CODES.WRITER_SCRIPT_UNSUPPORTED)

const startOf = (step: ScriptStep): number => ('at' in step ? step.at : step.startAt)

const endOf = (step: ScriptStep): number | null => {
  if (step.kind === 'reply' || step.kind === 'call' || step.kind === 'spawn' || step.kind === 'skill') {
    return step.endAt
  }
  return startOf(step)
}

// A reply's calls are the call, spawn and skill steps after it, up to the next prompt, reply, command or interrupt.
const isReplyCall = (step: ScriptStep): boolean =>
  step.kind === 'call' || step.kind === 'spawn' || step.kind === 'skill'

// Rule 4.
const checkCallStatus = (step: TCallStep): void => {
  if (step.status === 'pending' && (step.endAt !== null || step.result !== null)) {
    throw invalid(step.key, 'a pending call has an endAt or a result')
  }
  if (step.status === 'rejected' && step.endAt === null) {
    throw invalid(step.key, 'a rejected call has no endAt, the time the human refused it')
  }
}

// Rule 5.
const checkCallIntent = (step: TCallStep): void => {
  const intents = SCRIPT_INTENTS[step.family]
  if (intents === undefined) {
    if (step.intent !== null) {
      throw invalid(step.key, `the family ${step.family} takes no intent`)
    }
    return
  }
  const keys = step.intent === null ? undefined : intents[step.intent]
  if (keys === undefined) {
    throw invalid(step.key, `the family ${step.family} has no intent ${String(step.intent)}`)
  }
  const foreign = Object.keys(step.input).filter((key) => !keys.includes(key))
  if (foreign.length > 0) {
    throw invalid(step.key, `the intent ${String(step.intent)} has no input key ${foreign.join(', ')}`)
  }
}

const checkNamedTool = (step: TCallStep): void => {
  if (step.family === 'mcp' && (step.tool === null || step.server === null)) {
    throw invalid(step.key, 'an mcp call names no tool or no server')
  }
  if (step.family === 'other' && step.tool === null) {
    throw invalid(step.key, 'an other call names no tool')
  }
}

// What one pass over a session's steps keeps.
interface IStepWalk {
  previous: ScriptStep | null
  reply: TReplyStep | null
  replyCalls: number
}

const closeReply = (walk: IStepWalk): void => {
  const { reply } = walk
  if (reply?.text === null && reply.reasoning === null && walk.replyCalls === 0) {
    throw invalid(reply.key, 'a reply has no text, no reasoning and no call')
  }
  walk.reply = null
  walk.replyCalls = 0
}

// Rule 2 for a call, spawn or skill.
const checkReplyCall = (walk: IStepWalk, step: ScriptStep): void => {
  if (walk.reply === null) {
    throw invalid(step.key, 'a call, spawn or skill has no reply before it')
  }
  if (startOf(step) < walk.reply.endAt) {
    throw invalid(step.key, "the call starts before its reply's endAt")
  }
  walk.replyCalls += 1
}

// Rules 1 to 3 for one step in its session's order.
const checkStepOrder = (walk: IStepWalk, step: ScriptStep): void => {
  if (walk.previous !== null && startOf(step) < startOf(walk.previous)) {
    throw invalid(step.key, 'the step starts before the step before it')
  }
  const end = endOf(step)
  if (end !== null && end < startOf(step)) {
    throw invalid(step.key, 'the step ends before it starts')
  }
  if (step.kind === 'interrupt' && walk.previous === null) {
    throw invalid(step.key, "an interrupt is the session's first step")
  }
  if (isReplyCall(step)) {
    checkReplyCall(walk, step)
  } else if (step.kind !== 'event') {
    closeReply(walk)
    walk.reply = step.kind === 'reply' ? step : null
  }
}

const checkVersion = (script: ISessionScript, testedVersions: readonly string[]): void => {
  if (script.harnessVersion === null) {
    return
  }
  const minor = HARNESS_VERSION.exec(script.harnessVersion)?.groups?.minor
  if (minor === undefined || !testedVersions.includes(minor)) {
    throw invalid(script.key, `the harness version ${script.harnessVersion} is not one of the tested versions`)
  }
}

const checkKey = (keys: Set<string>, key: string): void => {
  if (keys.has(key)) {
    throw invalid(key, 'the key is not unique')
  }
  keys.add(key)
}

const checkScript = (script: ISessionScript, testedVersions: readonly string[], keys: Set<string>): void => {
  checkKey(keys, script.key)
  if (!isScriptProjectDir(script.projectDir)) {
    throw invalid(script.key, `the projectDir ${script.projectDir} ${PROJECT_DIR_RULE}`)
  }
  checkVersion(script, testedVersions)
  const walk: IStepWalk = { previous: null, reply: null, replyCalls: 0 }
  for (const step of script.steps) {
    checkKey(keys, step.key)
    checkStepOrder(walk, step)
    if (step.kind === 'call') {
      checkCallStatus(step)
      checkCallIntent(step)
      checkNamedTool(step)
    }
    if (step.kind === 'spawn') {
      checkScript(step.child, testedVersions, keys)
    }
    walk.previous = step
  }
  closeReply(walk)
}

const EVENT_CAPABILITIES: Readonly<Record<ScriptEvent['type'], SourceCapability | null>> = {
  'compaction': null,
  'failed-request': null,
  'model-switch': 'model-switch',
  'agent-switch': 'agent-switch',
  'idle': 'idle-event',
  'tools-offered': 'tools-offered',
  'tools-loaded': 'tools-loaded',
}

const callCapabilities = (step: TCallStep): SourceCapability[] => [
  ...(step.family === 'mcp' || step.server !== null ? (['mcp-server'] as const) : []),
  ...(step.status === 'rejected' ? (['tool-reject'] as const) : []),
]

type TStepCapabilities = {
  readonly [TKind in ScriptStep['kind']]: (
    step: Extract<ScriptStep, { kind: TKind }>,
    isChild: boolean
  ) => SourceCapability[]
}

// The capabilities each kind of step needs; a spawn in a spawned session needs nested-subagent.
const STEP_CAPABILITIES: TStepCapabilities = {
  prompt: (step) => (step.images > 0 ? ['image'] : []),
  reply: (step) => (step.cost === null ? [] : ['reported-cost']),
  call: callCapabilities,
  spawn: (_step, isChild) => (isChild ? ['nested-subagent'] : []),
  skill: () => [],
  command: (step) => (step.body === null ? ['typed-command'] : ['template-command']),
  event: (step) => {
    const capability = EVENT_CAPABILITIES[step.event.type]
    return capability === null ? [] : [capability]
  },
  interrupt: () => ['interrupt'],
}

const stepCapabilities = (step: ScriptStep, isChild: boolean): SourceCapability[] =>
  (STEP_CAPABILITIES[step.kind] as (step: ScriptStep, isChild: boolean) => SourceCapability[])(step, isChild)

const scriptCapabilities = (script: ISessionScript, isChild: boolean): SourceCapability[] => [
  ...(script.gitBranch === null ? [] : (['git-branch'] as const)),
  ...(script.agent !== null && !isChild ? (['session-agent'] as const) : []),
  ...(script.isScripted ? (['scripted'] as const) : []),
]

type TWriterFeatures = Pick<ISourceWriter, 'capabilities' | 'families'>

const checkSupported = (writer: TWriterFeatures, script: ISessionScript, isChild: boolean): void => {
  const missing = scriptCapabilities(script, isChild).find((capability) => !writer.capabilities.has(capability))
  if (missing !== undefined) {
    throw unsupported(script.key, `the writer cannot record ${missing}`)
  }
  for (const step of script.steps) {
    const needed = stepCapabilities(step, isChild).find((capability) => !writer.capabilities.has(capability))
    if (needed !== undefined) {
      throw unsupported(step.key, `the writer cannot record ${needed}`)
    }
    if (step.kind === 'call' && !writer.families.has(step.family)) {
      throw unsupported(step.key, `the writer cannot record a call of the family ${step.family}`)
    }
    if (step.kind === 'spawn') {
      checkSupported(writer, step.child, true)
    }
  }
}

// The script rules, harness-neutral, checked before a writer writes anything: every rule of the contract
// (WRITER_SCRIPT_INVALID), then every feature the writer must declare (WRITER_SCRIPT_UNSUPPORTED). Throws for the
// first problem, naming its script or step key.
export const checkScripts = (
  writer: TWriterFeatures,
  scripts: readonly ISessionScript[],
  testedVersions: readonly string[]
): void => {
  const keys = new Set<string>()
  for (const script of scripts) {
    checkScript(script, testedVersions, keys)
  }
  for (const script of scripts) {
    checkSupported(writer, script, false)
  }
}

// Rule 6 for command files: a project command file's directory is a script project directory. The error names the
// command file.
export const checkCommandFiles = (files: readonly ICommandFile[]): void => {
  const outside = files.find((file) => file.projectDir !== null && !isScriptProjectDir(file.projectDir))
  if (outside !== undefined) {
    throw new LogBookError(
      `Command file ${outside.name}: the projectDir ${String(outside.projectDir)} ${PROJECT_DIR_RULE}.`,
      SOURCE_WRITER_ERROR_CODES.WRITER_SCRIPT_INVALID
    )
  }
}
