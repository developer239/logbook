import { describe, expect, it } from 'vitest'
import { runCi } from './run-ci.js'

const run = async (argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
  let stdout = ''
  let stderr = ''
  const code = await runCi(argv, {
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
  })
  return { code, stdout, stderr }
}

describe('the ci command dispatcher', () => {
  it('exits 2 on an unknown command with one line naming it', async () => {
    // Act
    const result = await run(['nope'])

    // Assert
    expect(result).toStrictEqual({
      code: 2,
      stdout: '',
      stderr:
        'No command named nope; the commands are deps, fixtures, release, network, literals, tests, stage-cli, stage-libraries.\n',
    })
  })

  it('exits 2 when the literals command gets neither --harness nor --owner', async () => {
    // Act
    const result = await run(['literals'])

    // Assert
    expect(result).toStrictEqual({
      code: 2,
      stdout: '',
      stderr: 'This command takes --harness or --owner; got none.\n',
    })
  })

  it('exits 2 when no command is given', async () => {
    // Act
    const result = await run([])

    // Assert
    expect(result).toStrictEqual({
      code: 2,
      stdout: '',
      stderr:
        'No command given; the commands are deps, fixtures, release, network, literals, tests, stage-cli, stage-libraries.\n',
    })
  })
})
