import { existsSync } from 'node:fs'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The Claude Code version whose envelopes the fake answers with, recorded by `record:claude`.
const RECORDED_VERSION = '2.1.286'
const ENVELOPES = new URL(`../../fixtures/claude/${RECORDED_VERSION}/`, import.meta.url)
const CONFIG_FILE = 'claude-fake.json'
const RECORD_FILE = 'claude-calls.jsonl'

export type FakeClaudeEnvelope = 'usage-limit' | 'api-unreachable' | 'auth-refused' | 'other-error' | 'prompt-too-long'

const ENVELOPE_NAMES: readonly FakeClaudeEnvelope[] = [
  'usage-limit',
  'api-unreachable',
  'auth-refused',
  'other-error',
  'prompt-too-long',
]

// What the batch carrying the marker in one of its records gets. Rules address batches by content, never by arrival
// order, because a run has several batches in flight.
export type FakeClaudeRule = { marker: string } &
  // Only in a batch of at least `minItems` items when given, so the same record answers in a smaller batch.
  (
    | { kind: 'omit-tag'; minItems?: number }
    | { kind: 'delay'; ms: number }
    | { kind: 'hold'; file: string }
    | { kind: 'never' }
    | { kind: 'envelope'; envelope: FakeClaudeEnvelope }
    | { kind: 'exit'; code: number }
  )

export interface IFakeClaudeScenario {
  // The answer line for each tag of a batch whose --system-prompt contains `systemPrompt`; further lines of the answer
  // write `{tag}` for the tag, such as an entry line `\n{tag} + 0 1`.
  // `promptIncludes` narrows an answer to the batches whose stdin holds it, for tasks that share a system line.
  answers?: { systemPrompt: string; answer: string; promptIncludes?: string }[]
  rules?: FakeClaudeRule[]
  // Another version for --version, such as `2.0.10`.
  version?: string
  // Overrides of `auth status --json`; signed out exits 1.
  auth?: { loggedIn?: boolean; authMethod?: string; apiProvider?: string }
  // An invented variable the fake checks arrived verbatim and occurs nowhere in stdin, recording only the two answers.
  canary?: { name: string; value: string }
}

export interface IFakeClaudeRecord {
  counter: number
  pid: number
  argv: string[]
  model: string | null
  stdin: string
  cwd: string
  cwdExisted: boolean
  cwdWasEmpty: boolean
  maxThinkingTokens: string | null
  disableNonessentialTraffic: string | null
  hasApiKey: boolean
  isApiKeyInStdin: boolean
  // The names of every other variable, sorted; never a value.
  otherVariables: string[]
  canary: { isArrived: boolean; isInStdin: boolean } | null
  // Read when the test reads the records.
  cwdStillExists: boolean
}

export interface IFakeClaude {
  path: string
  readRecords: () => Promise<IFakeClaudeRecord[]>
}

// The fake itself, in CommonJS so it runs as a plain script under the Node that runs the test.
const FAKE_SCRIPT = String.raw`'use strict'
const fs = require('node:fs')
const path = require('node:path')
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'claude-fake.json'), 'utf8'))
const args = process.argv.slice(2)
const SPECIAL = new Set(['MAX_THINKING_TOKENS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'ANTHROPIC_API_KEY'])

const valueAfter = (flag) => {
  const index = args.indexOf(flag)
  return index === -1 || index + 1 >= args.length ? null : args[index + 1]
}

const record = (stdin) => {
  const cwd = process.cwd()
  const cwdExisted = fs.existsSync(cwd)
  const previous = fs.existsSync(config.recordFile) ? fs.readFileSync(config.recordFile, 'utf8').split('\n').filter(Boolean).length : 0
  const apiKey = process.env.ANTHROPIC_API_KEY
  const canary = config.canary
  const entry = {
    counter: previous + 1,
    pid: process.pid,
    argv: args,
    model: valueAfter('--model'),
    stdin,
    cwd,
    cwdExisted,
    cwdWasEmpty: cwdExisted && fs.readdirSync(cwd).length === 0,
    maxThinkingTokens: process.env.MAX_THINKING_TOKENS ?? null,
    disableNonessentialTraffic: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null,
    hasApiKey: apiKey !== undefined,
    isApiKeyInStdin: apiKey !== undefined && apiKey !== '' && stdin.includes(apiKey),
    otherVariables: Object.keys(process.env).filter((name) => !SPECIAL.has(name)).sort(),
    canary: canary ? { isArrived: process.env[canary.name] === canary.value, isInStdin: stdin.includes(canary.value) } : null,
  }
  fs.appendFileSync(config.recordFile, JSON.stringify(entry) + '\n')
}

const print = (envelope) => {
  process.stdout.write(JSON.stringify(envelope))
  process.exit(envelope.is_error ? 1 : 0)
}

const answer = (stdin, omitted) => {
  const systemPrompt = valueAfter('--system-prompt') ?? ''
  const match = config.answers.find(
    (candidate) =>
      systemPrompt.includes(candidate.systemPrompt) &&
      (candidate.promptIncludes === undefined || stdin.includes(candidate.promptIncludes))
  )
  if (!match) {
    process.stderr.write('The fake has no answer for this system prompt\n')
    process.exit(2)
  }
  const tags = [...stdin.matchAll(/^### (#\d+)$/gm)].map((found) => found[1]).filter((tag) => tag !== omitted)
  print({ ...config.envelopes.success, result: tags.map((tag) => tag + ' ' + match.answer.replaceAll('{tag}', tag)).join('\n') })
}

// The tag of the section of stdin that holds the marker.
const tagHolding = (stdin, marker) => {
  let current = null
  for (const line of stdin.split('\n')) {
    const tag = /^### (#\d+)$/.exec(line)
    if (tag) {
      current = tag[1]
    } else if (line.includes(marker)) {
      return current
    }
  }
  return null
}

const respond = (stdin) => {
  const rule = config.rules.find((candidate) => stdin.includes(candidate.marker))
  if (!rule) {
    answer(stdin, null)
    return
  }
  switch (rule.kind) {
    case 'omit-tag': {
      const items = stdin.split('\n').filter((line) => /^### #\d+$/.test(line)).length
      answer(stdin, items >= (rule.minItems ?? 0) ? tagHolding(stdin, rule.marker) : null)
      return
    }
    case 'delay':
      setTimeout(() => answer(stdin, null), rule.ms)
      return
    case 'hold': {
      const timer = setInterval(() => {
        if (fs.existsSync(rule.file)) {
          clearInterval(timer)
          answer(stdin, null)
        }
      }, 20)
      return
    }
    case 'never':
      setInterval(() => {}, 1000)
      return
    case 'envelope':
      print(config.envelopes[rule.envelope])
      return
    case 'exit':
      process.exit(rule.code)
  }
}

// The real claude ends when its caller is gone and its output pipe breaks. The fake does too, so a rule that holds or
// never answers cannot outlive a caller that was killed before it could stop its child.
const watchCaller = () => {
  const caller = process.ppid
  setInterval(() => {
    if (process.ppid !== caller) {
      process.exit(1)
    }
  }, 100).unref()
}

// Armed before the call is recorded: a test kills the caller as soon as the record appears, and a fake that read its
// parent only after that could read the process it was reparented to.
watchCaller()
const isPrint = args.includes('-p')
const stdin = isPrint ? fs.readFileSync(0, 'utf8') : ''
record(stdin)
if (args[0] === '--version') {
  process.stdout.write(config.version + '\n')
} else if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify(config.auth))
  process.exit(config.auth.loggedIn ? 0 : 1)
} else if (isPrint) {
  respond(stdin)
} else {
  process.stderr.write('The fake does not know this command\n')
  process.exit(2)
}
`

const readEnvelope = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`${name}.json`, ENVELOPES), 'utf8')) as unknown

// Writes an executable `claude` into dir that records every call and answers from the envelopes recorded from the
// real Claude Code, or from the scenario's overrides. Its shebang names the Node running the test, so it runs under any
// PATH a test gives the engine.
export const installFakeClaude = async (dir: string, scenario: IFakeClaudeScenario = {}): Promise<IFakeClaude> => {
  const recordFile = join(dir, RECORD_FILE)
  const recordedVersion = (await readFile(new URL('version.txt', ENVELOPES), 'utf8')).trim()
  const auth = (await readEnvelope('auth-status')) as Record<string, unknown>
  const envelopes = Object.fromEntries(
    await Promise.all(['success', ...ENVELOPE_NAMES].map(async (name) => [name, await readEnvelope(name)] as const))
  )
  const config = {
    recordFile,
    version: scenario.version === undefined ? recordedVersion : `${scenario.version} (Claude Code)`,
    auth: { ...auth, ...scenario.auth },
    envelopes,
    answers: scenario.answers ?? [],
    rules: scenario.rules ?? [],
    canary: scenario.canary ?? null,
  }
  const path = join(dir, 'claude')
  await writeFile(join(dir, CONFIG_FILE), JSON.stringify(config))
  await writeFile(path, `#!${process.execPath}\n${FAKE_SCRIPT}`)
  await chmod(path, 0o755)
  return {
    path,
    readRecords: async () => {
      if (!existsSync(recordFile)) {
        return []
      }
      return (await readFile(recordFile, 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => {
          const entry = JSON.parse(line) as Omit<IFakeClaudeRecord, 'cwdStillExists'>
          return { ...entry, cwdStillExists: existsSync(entry.cwd) }
        })
    },
  }
}
