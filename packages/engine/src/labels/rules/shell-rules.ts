import { RULES_LABELLER, type ILabelRecord } from '@log-book/warehouse'
import type { ShellPurpose } from '../vocabularies.js'

// Rule labels are rebuilt on every sync at no cost, so their version is a constant here, not a task version.
const SHELL_RULES_VERSION = 2

// Setup in front of the command that tells nothing about it: variable assignments, `cd <dir>`, `export`, `set -e`,
// each ended by `&&`, `;` or a newline.
const SETUP =
  /^(?:\s*(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\$\([^)]*\)|\S*)\s*;?\s*|cd\s+\S+\s*(?:&&|;|\n)\s*|export\s+\S+\s*(?:&&|;|\n)?\s*|set\s+-\S+\s*(?:&&|;|\n)\s*))+/u

// A command that writes a file (a redirect that is not `2>&1`, or a heredoc) is left to a model: whether it writes
// notes, code or a probe decides its purpose.
const WRITES_A_FILE = /(?<![\d&])>(?!&)|<</u

// The purposes the command itself settles, first match wins. What is left (scripts, writes, mixed reads, anything
// unlisted) is a model's to judge.
const SHELL_RULES: readonly (readonly [ShellPurpose, RegExp, boolean])[] = [
  // [purpose, pattern, applies to a command that writes a file]
  ['wait for something', /^(?:sleep|until|while)\b|\bsleep \d/u, true],
  ['pull request or CI', /^gh\b/u, false],
  [
    'change git (commit, push, branch, rebase)',
    /^git (?:add|commit|push|rebase|merge|checkout|switch|reset|stash|cherry-pick|worktree (?:add|remove)|branch -[dDmM]|tag|pull|fetch)\b/u,
    false,
  ],
  ['inspect git state', /^git\b/u, false],
  [
    'run tests',
    /\b(?:pnpm|npm|yarn|npx)(?: -C \S+| --dir \S+| --filter \S+)* (?:run )?test\b|\bvitest\b|\bjest\b|node --test/u,
    false,
  ],
  [
    'check a change (format, lint, typecheck, build)',
    /\b(?:pnpm|npm|yarn|npx)\b.*\b(?:build|typecheck|tsc|lint|format|oxlint|oxfmt|eslint|prettier|turbo)\b|^tsc\b/u,
    false,
  ],
  ['install or set up', /\b(?:pnpm|npm|yarn) (?:install|add|remove|i)\b/u, false],
  ['query a service (http, database, cloud, docker)', /^(?:psql|sqlite3|mysql|curl|docker|aws)\b/u, false],
  ['read or search code', /^(?:grep|rg|find|ls|tree|fd|cat|sed -n|head|tail|nl|wc)\b/u, false],
]

export interface IShellCall {
  id: string
  family: string
  inputJson: string
}

// The purpose the rules give a command, or null when they leave it to a model.
export const shellRulePurpose = (command: string): ShellPurpose | null => {
  const body = command.trim().replace(SETUP, '')
  const isWrite = WRITES_A_FILE.test(body)
  const rule = SHELL_RULES.find(([, pattern, isForWrites]) => (isForWrites || !isWrite) && pattern.test(body))
  return rule?.[0] ?? null
}

// The command a shell call's input holds under `command`, or else under `cmd`.
const commandOf = (inputJson: string): string | null => {
  let input: unknown = null
  try {
    input = JSON.parse(inputJson)
  } catch {
    return null
  }
  if (typeof input !== 'object' || input === null) {
    return null
  }
  const { command, cmd } = input as { command?: unknown; cmd?: unknown }
  if (typeof command === 'string') {
    return command
  }
  return typeof cmd === 'string' ? cmd : null
}

// One purpose label per shell call the rules settle; labelledAt is the caller's.
export const shellRuleLabels = (calls: readonly IShellCall[], labelledAt: number): ILabelRecord[] =>
  calls.flatMap((call) => {
    const command = call.family === 'shell' ? commandOf(call.inputJson) : null
    const purpose = command === null ? null : shellRulePurpose(command)
    if (purpose === null) {
      return []
    }
    return [
      {
        recordType: 'tool_call',
        recordId: call.id,
        labeller: RULES_LABELLER,
        version: SHELL_RULES_VERSION,
        name: 'purpose',
        value: purpose,
        labelledAt,
      },
    ]
  })
