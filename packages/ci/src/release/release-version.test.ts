import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitWorkspaces } from '../testing/git-workspace.js'
import { releaseVersion, type TSemanticRelease } from './release-version.js'

const OUTPUT = 'github-output'
const EARLIER = 'earlier=step\n'
const workspaces = gitWorkspaces()

// The command run in a workspace holding an output file, with semantic-release replaced by this stand-in.
const runRelease = async (
  args: readonly string[],
  release: TSemanticRelease,
  env: Record<string, string> = {}
): Promise<{ code: number; stderr: string; output: string; dryRuns: boolean[] }> => {
  const root = await workspaces.create({ [OUTPUT]: EARLIER })
  const dryRuns: boolean[] = []
  let stderr = ''
  const code = await releaseVersion(args, {
    stderr: (text) => {
      stderr += text
    },
    env: { GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: join(root, OUTPUT), ...env },
    cwd: root,
    release: async (options, environment) => {
      dryRuns.push(options.dryRun === true)
      return release(options, environment)
    },
  })
  return { code, stderr, output: await readFile(join(root, OUTPUT), 'utf8'), dryRuns }
}

afterEach(async () => {
  await workspaces.removeAll()
})

describe('releaseVersion', () => {
  it('writes the decided version to the output file', async () => {
    // Act
    const result = await runRelease([], async () => Promise.resolve({ nextRelease: { version: '1.4.0' } }))

    // Assert
    expect(result).toStrictEqual({ code: 0, stderr: '', output: `${EARLIER}version=1.4.0\n`, dryRuns: [false] })
  })

  it('writes an empty version when no release is due', async () => {
    // Act
    const result = await runRelease([], async () => Promise.resolve(false))

    // Assert
    expect(result).toStrictEqual({ code: 0, stderr: '', output: `${EARLIER}version=\n`, dryRuns: [false] })
  })

  it("exits 1 with semantic-release's messages and leaves the output file unchanged", async () => {
    // Act
    const result = await runRelease([], async () =>
      Promise.reject(new AggregateError([new Error('No GitHub token specified.'), new Error('No git repository.')]))
    )

    // Assert
    expect(result).toStrictEqual({
      code: 1,
      stderr: 'No GitHub token specified.\nNo git repository.\n',
      output: EARLIER,
      dryRuns: [false],
    })
  })

  it('runs a dry run that writes nothing', async () => {
    // Act
    const result = await runRelease(['--dry-run'], async () => Promise.resolve({ nextRelease: { version: '1.0.0' } }))

    // Assert
    expect(result).toStrictEqual({ code: 0, stderr: '', output: EARLIER, dryRuns: [true] })
  })

  it('stops under GitHub Actions without GITHUB_OUTPUT, naming it, before deciding anything', async () => {
    // Act
    const result = await runRelease([], async () => Promise.resolve({ nextRelease: { version: '1.4.0' } }), {
      GITHUB_OUTPUT: '',
    })

    // Assert
    expect(result).toStrictEqual({
      code: 1,
      stderr:
        'GITHUB_OUTPUT is not set; under GitHub Actions the release command writes the version to the file it names.\n',
      output: EARLIER,
      dryRuns: [],
    })
  })

  it('exits 2 on an argument other than --dry-run', async () => {
    // Act
    const result = await runRelease(['--publish'], async () => Promise.resolve(false))

    // Assert
    expect(result).toStrictEqual({
      code: 2,
      stderr: 'This command takes only --dry-run; got --publish.\n',
      output: EARLIER,
      dryRuns: [],
    })
  })
})
