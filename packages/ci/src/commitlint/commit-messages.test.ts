import { fileURLToPath } from 'node:url'
import lint from '@commitlint/lint'
import load from '@commitlint/load'
import { describe, expect, it } from 'vitest'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

// The names of the rules the repository's commitlint configuration refuses a message by; none when it accepts it.
const refusals = async (message: string): Promise<string[]> => {
  const config = await load({}, { cwd: REPOSITORY_ROOT })
  const report = await lint(message, config.rules, {
    plugins: config.plugins,
    ...(config.parserPreset?.parserOpts === undefined
      ? {}
      : { parserOpts: config.parserPreset.parserOpts as Record<string, unknown> }),
  })
  return report.errors.map((error) => error.name)
}

describe('the commit message rules', () => {
  it.each(['feat: show turn time per harness', 'fix!: drop the --json flag'])('accepts %j', async (message) => {
    // Act
    const refused = await refusals(message)

    // Assert
    expect(refused).toStrictEqual([])
  })

  it.each([
    ['a header with no type', 'add things', ['subject-empty', 'type-empty']],
    ['a ticket key before the type', 'KAN-12 feat: add things', ['subject-empty', 'type-empty']],
    ['a body that does not follow a blank line', 'feat: add things\nexample body', ['body-leading-blank']],
    [
      'a Co-Authored-By trailer',
      'feat: add things\n\nCo-Authored-By: Example <example@example.com>',
      ['no-attribution'],
    ],
    [
      'the trailer in lower case',
      'feat: add things\n\nco-authored-by: Example <example@example.com>',
      ['no-attribution'],
    ],
    [
      'the trailer in upper case',
      'feat: add things\n\nCO-AUTHORED-BY: Example <example@example.com>',
      ['no-attribution'],
    ],
    ['a Generated with line', 'feat: add things\n\nGenerated with an assistant', ['no-attribution']],
  ])('refuses %s, naming its rule', async (_case, message, rules) => {
    // Act
    const refused = await refusals(message)

    // Assert
    expect(refused.toSorted()).toStrictEqual(rules)
  })
})
