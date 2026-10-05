import { LABEL_TASK_NAMES, type ClaudeDetection } from '@log-book/engine'
import { describe, expect, it } from 'vitest'
import {
  doctorLabellingLine,
  hostLabellingLine,
  missingPrerequisite,
  taskCountWords,
  taskWords,
} from './labelling-lines.js'

interface ILines {
  host: string
  doctor: string
  command: { code: number; line: string } | null
}

const HOME = '/home/example'
const BINARY = `${HOME}/.local/bin/claude`
const INSTALL = 'needs Claude Code: install it (https://claude.com/claude-code) or set CLAUDE_BIN'

const ready = (fields: Partial<Extract<ClaudeDetection, { status: 'ready' }>> = {}): ClaudeDetection => ({
  status: 'ready',
  binary: BINARY,
  version: '2.1.286',
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  hasApiKey: false,
  ...fields,
})

const linesOf = (detection: ClaudeDetection): ILines => ({
  host: hostLabellingLine(detection),
  doctor: doctorLabellingLine(detection, HOME),
  command: missingPrerequisite(detection),
})

describe('the labelling prerequisite lines', () => {
  it('words a Claude subscription as ready, with the default model', () => {
    // Act
    const lines = linesOf(ready())

    // Assert
    expect(lines).toStrictEqual({
      host: 'Labelling    ready: claude 2.1.286, signed in with a Claude subscription; default model claude-haiku-4-5',
      doctor:
        'Labelling   ready: claude 2.1.286 at ~/.local/bin/claude, signed in with a Claude subscription; default model claude-haiku-4-5',
      command: null,
    })
  })

  it.each([
    ['a Console sign-in', ready({ authMethod: 'console' }), 'an API key'],
    ['an API key in the environment over a subscription', ready({ hasApiKey: true }), 'an API key'],
    ['a cloud provider', ready({ authMethod: 'console', apiProvider: 'bedrock' }), 'Amazon Bedrock'],
    ['an OAuth token', ready({ authMethod: 'oauth_token' }), 'an OAuth token'],
    ['a kind the lines do not know, as reported', ready({ authMethod: 'example_method' }), 'example_method'],
  ])('words %s as billed to that account', (_case, detection, kind) => {
    // Act
    const lines = linesOf(detection)

    // Assert
    expect(lines).toStrictEqual({
      host: `Labelling    ready: claude 2.1.286, signed in with ${kind}; labelling is billed to that account; default model claude-haiku-4-5`,
      doctor: `Labelling   ready: claude 2.1.286 at ~/.local/bin/claude, signed in with ${kind}; labelling is billed to that account; default model claude-haiku-4-5`,
      command: null,
    })
  })

  it.each([
    ['claude not on the PATH', { kind: 'not-found', variable: null }, INSTALL],
    ['CLAUDE_BIN naming no executable', { kind: 'not-found', variable: 'CLAUDE_BIN' }, INSTALL],
    [
      'claude too old',
      { kind: 'too-old', version: '2.0.10', minimum: '2.1.286' },
      'needs Claude Code 2.1.286 or newer; found 2.0.10. Update it with: claude update',
    ],
    [
      'a version claude did not print',
      { kind: 'version-unreadable' },
      'needs Claude Code 2.1.286 or newer; claude --version printed no version. Update it with: claude update',
    ],
    [
      'claude not signed in',
      { kind: 'not-signed-in' },
      'Claude Code is not signed in. Run claude, sign in, then run this again.',
    ],
  ] as const)('words %s for the host and doctor, and stops a labelling command at exit 7', (_case, missing, text) => {
    // Act
    const lines = linesOf({ status: 'missing', missing })

    // Assert
    expect(lines).toStrictEqual({
      host: `Labelling    ${text}`,
      doctor: `Labelling   ${text}`,
      command: { code: 7, line: text },
    })
  })
})

describe('the task words', () => {
  it('names one record of each task in the singular and several in the plural', () => {
    // Act
    const words = LABEL_TASK_NAMES.map((task) => [taskWords(task, 1), taskWords(task, 1200)])

    // Assert
    expect(words).toStrictEqual([
      ['1 shell call', '1,200 shell calls'],
      ['1 failed tool call', '1,200 failed tool calls'],
      ['1 session', '1,200 sessions'],
      ['1 outcome', '1,200 outcomes'],
      ['1 prompt', '1,200 prompts'],
      ['1 reply', '1,200 replies'],
    ])
  })

  it('leaves out a task with nothing to label and keeps the task order', () => {
    // Act
    const words = taskCountWords({ reply: 2, shell: 1, prompt: 0 })

    // Assert
    expect(words).toStrictEqual(['1 shell call', '2 replies'])
  })
})
