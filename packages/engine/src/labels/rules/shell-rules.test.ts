import { describe, expect, it } from 'vitest'
import { SHELL_PURPOSES } from '../vocabularies.js'
import { shellRuleLabels, shellRulePurpose } from './shell-rules.js'

describe('shellRulePurpose', () => {
  it.each([
    ['gh pr view 12', 'pull request or CI'],
    ['git commit -m "fix"', 'change git (commit, push, branch, rebase)'],
    ['git log -3', 'inspect git state'],
    ['pnpm test', 'run tests'],
    ['pnpm build', 'check a change (format, lint, typecheck, build)'],
    ['pnpm add zod', 'install or set up'],
    ['curl -s localhost:3000/health', 'query a service (http, database, cloud, docker)'],
    ['rg TODO src', 'read or search code'],
    ['sleep 30', 'wait for something'],
  ])('gives %s the purpose %s', (command, purpose) => {
    // Arrange and act
    const result = shellRulePurpose(command)

    // Assert
    expect(result).toBe(purpose)
  })

  it('strips leading setup first', () => {
    // Arrange
    const commands = ['cd app && FOO=1 git status', 'export CI=1; pnpm test']

    // Act
    const purposes = commands.map(shellRulePurpose)

    // Assert
    expect(purposes).toStrictEqual(['inspect git state', 'run tests'])
  })

  it('leaves a command that writes a file to the model, except a wait', () => {
    // Arrange
    const commands = ['sleep 30 > /dev/null', 'echo done > notes.txt', 'cat > notes.md <<EOF\nhi\nEOF']

    // Act
    const purposes = commands.map(shellRulePurpose)

    // Assert
    expect(purposes).toStrictEqual(['wait for something', null, null])
  })

  it('does not count 2>&1 as a write', () => {
    // Arrange
    const command = 'pnpm test 2>&1'

    // Act
    const purpose = shellRulePurpose(command)

    // Assert
    expect(purpose).toBe('run tests')
  })

  it('reads a plan under /tmp as code, and has no orchestration purpose', () => {
    // Arrange
    const command = 'cat /tmp/plans/plan.md'

    // Act
    const purpose = shellRulePurpose(command)

    // Assert
    expect({
      purpose,
      isOrchestrationPurpose: SHELL_PURPOSES.some((value) => value.includes('orchestration')),
    }).toStrictEqual({
      purpose: 'read or search code',
      isOrchestrationPurpose: false,
    })
  })
})

describe('shellRuleLabels', () => {
  it('labels the calls the rules settle, reading cmd when command is absent, and skips calls with no command', () => {
    // Arrange
    const calls = [
      { id: 'test-harness:s1/c1', family: 'shell', inputJson: '{"command":"git status"}' },
      { id: 'test-harness:s1/c2', family: 'shell', inputJson: '{"cmd":"pnpm test"}' },
      { id: 'test-harness:s1/c3', family: 'shell', inputJson: '{}' },
      { id: 'test-harness:s1/c4', family: 'shell', inputJson: '{"command":"python3 build.py"}' },
      { id: 'test-harness:s1/c5', family: 'read', inputJson: '{"command":"git status"}' },
    ]

    // Act
    const labels = shellRuleLabels(calls, 1_000)

    // Assert
    expect(labels).toStrictEqual([
      {
        recordType: 'tool_call',
        recordId: 'test-harness:s1/c1',
        labeller: 'rules',
        version: 2,
        name: 'purpose',
        value: 'inspect git state',
        labelledAt: 1_000,
      },
      {
        recordType: 'tool_call',
        recordId: 'test-harness:s1/c2',
        labeller: 'rules',
        version: 2,
        name: 'purpose',
        value: 'run tests',
        labelledAt: 1_000,
      },
    ])
  })
})
