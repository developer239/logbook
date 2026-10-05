import {
  CLAUDE_MINIMUM_VERSION,
  DEFAULT_LABEL_MODEL,
  LABEL_TASK_NAMES,
  type ClaudeDetection,
  type ClaudeMissing,
  type LabelTaskName,
} from '@log-book/engine'
import { exitCodeOf, type IErrorReport } from './errors.js'
import { formatCount, tildePath } from './format.js'

type TReady = Extract<ClaudeDetection, { status: 'ready' }>

// `Labelling` and four spaces on the host's start, three in doctor's report.
const HOST_COLUMN = 'Labelling    '
const DOCTOR_COLUMN = 'Labelling   '
const SUBSCRIPTION = 'claude.ai'
const API_KEY = 'an API key'
const INSTALL = 'needs Claude Code: install it (https://claude.com/claude-code) or set CLAUDE_BIN'

// The sign-in kinds `claude auth status` reports, as the lines name them; a kind not listed is named as reported.
const AUTH_METHODS: Readonly<Record<string, string>> = {
  console: API_KEY,
  api_key: API_KEY,
  oauth_token: 'an OAuth token',
}
const API_PROVIDERS: Readonly<Record<string, string>> = {
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
}

const TASK_WORDS: Readonly<Record<LabelTaskName, { one: string; many: string }>> = {
  'shell': { one: 'shell call', many: 'shell calls' },
  'tool-failure': { one: 'failed tool call', many: 'failed tool calls' },
  'session': { one: 'session', many: 'sessions' },
  'outcome': { one: 'outcome', many: 'outcomes' },
  'prompt': { one: 'prompt', many: 'prompts' },
  'reply': { one: 'reply', many: 'replies' },
}

// The text after the column for each reason labelling cannot run.
const MISSING_TEXTS: {
  readonly [TKind in ClaudeMissing['kind']]: (missing: Extract<ClaudeMissing, { kind: TKind }>) => string
} = {
  'not-found': () => INSTALL,
  'version-unreadable': () =>
    `needs Claude Code ${CLAUDE_MINIMUM_VERSION} or newer; claude --version printed no version. Update it with: claude update`,
  'too-old': ({ version, minimum }) =>
    `needs Claude Code ${minimum} or newer; found ${version}. Update it with: claude update`,
  'not-signed-in': () => 'Claude Code is not signed in. Run claude, sign in, then run this again.',
}

const missingText = <TMissing extends ClaudeMissing>(missing: TMissing): string =>
  (MISSING_TEXTS[missing.kind] as (missing: TMissing) => string)(missing)

// What a print-mode run is billed to: an API key in the environment wins over the sign-in, then a cloud provider,
// then the sign-in method itself. Nothing about the account is read.
const signInOf = ({ authMethod, apiProvider, hasApiKey }: TReady): string | null => {
  if (hasApiKey) {
    return API_KEY
  }
  const provider = apiProvider === null ? undefined : API_PROVIDERS[apiProvider]
  if (provider !== undefined) {
    return provider
  }
  if (authMethod === SUBSCRIPTION) {
    return null
  }
  return authMethod === null ? 'a sign-in claude did not name' : (AUTH_METHODS[authMethod] ?? authMethod)
}

const readyText = (detection: TReady, binary: string | null): string => {
  const at = binary === null ? '' : ` at ${binary}`
  const signIn = signInOf(detection)
  const billing =
    signIn === null
      ? 'signed in with a Claude subscription'
      : `signed in with ${signIn}; labelling is billed to that account`
  return `ready: claude ${detection.version}${at}, ${billing}; default model ${DEFAULT_LABEL_MODEL}`
}

// The labelling line of the host's start: information, the host keeps going in every state.
export const hostLabellingLine = (detection: ClaudeDetection): string =>
  HOST_COLUMN + (detection.status === 'ready' ? readyText(detection, null) : missingText(detection.missing))

// The labelling line of doctor's report, with the binary `claude` resolved to.
export const doctorLabellingLine = (detection: ClaudeDetection, home: string): string =>
  DOCTOR_COLUMN +
  (detection.status === 'ready'
    ? readyText(detection, tildePath(detection.binary, home))
    : missingText(detection.missing))

// What a labelling command stops with: exit 7, `missing prerequisite`, and the text after the column; null when
// labelling can run.
export const missingPrerequisite = (detection: ClaudeDetection): IErrorReport | null =>
  detection.status === 'ready'
    ? null
    : { code: exitCodeOf('missing prerequisite'), line: missingText(detection.missing) }

// How every text names a task's records: `1 shell call`, `12 failed tool calls`.
export const taskWords = (task: LabelTaskName, count: number): string => {
  const words = TASK_WORDS[task]
  return `${formatCount(count)} ${count === 1 ? words.one : words.many}`
}

// The tasks with something to label, in the engine's task order, each in its words.
export const taskCountWords = (counts: Readonly<Partial<Record<LabelTaskName, number>>>): string[] =>
  LABEL_TASK_NAMES.flatMap((task) => {
    const count = counts[task] ?? 0
    return count === 0 ? [] : [taskWords(task, count)]
  })
