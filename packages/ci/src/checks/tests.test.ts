import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitWorkspaces } from '../testing/git-workspace.js'
import { checkTests } from './tests.js'

interface IRun {
  code: number
  stdout: string
  stderr: string
}

const TEST = 'packages/core/src/example.test.ts'
const ISSUE = 'https://github.com/developer239/logbook/issues/12'
const workspaces = gitWorkspaces()

// The test source is built at run time, so this file's own text holds nothing the check would refuse.
const NAMED = "('reads a cut line', () => {})"
const call = (name: string, modifier: string, args = NAMED): string => `${name}.${modifier}${args}`
const flaky = `// flaky: ${ISSUE}`
const retrySetting = (count: number): string => `${['retry', String(count)].join(': ')},`
const source = (...lines: string[]): string => `${lines.join('\n')}\n`

const check = async (files: Readonly<Record<string, string>>, env: Record<string, string> = {}): Promise<IRun> => {
  const root = await workspaces.create(files)
  let stdout = ''
  let stderr = ''
  const code = await checkTests(root, {
    env,
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
  })
  return { code, stdout, stderr }
}

afterEach(async () => {
  await workspaces.removeAll()
})

describe('the test conventions check', () => {
  it.each([
    ['a retry setting in a test file', TEST, source(`describe('x', { ${retrySetting(2)} }, () => {})`), 'no-retry'],
    ['a retry setting in the Vitest configuration', 'vitest.config.ts', source(retrySetting(2)), 'no-retry'],
    ['a retry call', TEST, source(call('it', 'retry', '(3)')), 'no-retry'],
    ['a focused test', TEST, source(call('it', 'only')), 'no-only'],
    ['a focused suite', TEST, source(call('describe', 'only')), 'no-only'],
    ['a chained focused test', TEST, source(call('it.concurrent', 'only')), 'no-only'],
    ['a skip without its comment', TEST, source(call('it', 'skip')), 'quarantine'],
    ['the comment two lines above', TEST, source(flaky, '', call('it', 'skip')), 'quarantine'],
    ['a todo without its comment', TEST, source(call('it', 'todo')), 'quarantine'],
  ])('refuses %s, naming the file, the line and the rule', async (_case, file, text, rule) => {
    // Act
    const result = await check({ [file]: text })

    // Assert
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(new RegExp(`^${file.replaceAll('.', '\\.')}:\\d+: .* \\[${rule}\\]\\n$`, 'u'))
  })

  it.each([
    ['a quarantined skip', source(flaky, call('it', 'skip'))],
    ['a quarantined todo', source(flaky, call('it', 'todo'))],
  ])('passes %s and lists it with its file, name and issue', async (_case, text) => {
    // Act
    const result = await check({ [TEST]: text })

    // Assert
    expect(result).toStrictEqual({
      code: 0,
      stdout: `## Quarantined tests\n\n- ${TEST}: reads a cut line (${ISSUE})\n`,
      stderr: '',
    })
  })

  it.each([
    ['a conditional skip', source(call('it', 'skipIf', `(true)${NAMED}`))],
    ['retry: 0, which asks for none', source(retrySetting(0))],
  ])('passes %s and lists no quarantine', async (_case, text) => {
    // Act
    const result = await check({ [TEST]: text })

    // Assert
    expect(result).toStrictEqual({ code: 0, stdout: '## Quarantined tests\n\nNone\n', stderr: '' })
  })

  it('appends the section to a job summary that already holds text, under GitHub Actions', async () => {
    // Arrange
    const root = await workspaces.create({ [TEST]: source(flaky, call('it', 'skip')) })
    const summary = join(root, 'summary.md')
    await writeFile(summary, 'Shuffle seed: 1\n')

    // Act
    const code = await checkTests(root, {
      env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary },
      stdout: () => undefined,
      stderr: () => undefined,
    })

    // Assert
    expect({ code, summary: await readFile(summary, 'utf8') }).toStrictEqual({
      code: 0,
      summary: `Shuffle seed: 1\n\n## Quarantined tests\n\n- ${TEST}: reads a cut line (${ISSUE})\n`,
    })
  })

  it('stops under GitHub Actions without GITHUB_STEP_SUMMARY, naming it', async () => {
    // Act
    const result = await check({ [TEST]: source(call('it', 'skip')) }, { GITHUB_ACTIONS: 'true' })

    // Assert
    expect(result).toStrictEqual({
      code: 2,
      stdout: '',
      stderr: 'Under GitHub Actions the quarantine section goes to GITHUB_STEP_SUMMARY, which is not set.\n',
    })
  })
})
