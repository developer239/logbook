import { appendFile } from 'node:fs/promises'
import type { Config, Options } from 'semantic-release'

// semantic-release's API, as far as the command reads its result: false when no release is due.
export type TSemanticRelease = (
  options: Options,
  environment: Config
) => Promise<false | { nextRelease: { version: string } }>

interface IReleaseContext {
  stderr: (text: string) => void
  env: Readonly<Record<string, string | undefined>>
  cwd: string
  release: TSemanticRelease
}

const DRY_RUN = '--dry-run'
const WRONG_ARGUMENTS = 2

// Each message of a failed run: semantic-release throws one error, or an AggregateError of several.
const messagesOf = (error: unknown): string[] => {
  if (error instanceof AggregateError) {
    return error.errors.flatMap((inner: unknown) => messagesOf(inner))
  }
  return [error instanceof Error ? error.message : String(error)]
}

// The file GITHUB_OUTPUT names, or undefined when it names none.
const outputFileOf = (env: IReleaseContext['env']): string | undefined =>
  env.GITHUB_OUTPUT === undefined || env.GITHUB_OUTPUT === '' ? undefined : env.GITHUB_OUTPUT

// semantic-release's decision, or the exit code of its failure after its messages.
const decide = async (isDryRun: boolean, context: IReleaseContext): Promise<string | undefined | number> => {
  const { stderr, env, cwd, release } = context
  try {
    const result = await release({ dryRun: isDryRun }, { cwd, env, stdout: process.stdout, stderr: process.stderr })
    return result === false ? undefined : result.nextRelease.version
  } catch (error) {
    for (const message of messagesOf(error)) {
      stderr(`${message}\n`)
    }
    return 1
  }
}

// `pnpm release:version [--dry-run]`: semantic-release decides the next version from the commits on main with
// .releaserc.json, pushes its tag and writes its GitHub release; the version leaves it only here, as `version=X.Y.Z`,
// or `version=` when none is due, in the file GITHUB_OUTPUT names. A dry run decides and prints it and writes nothing.
export const releaseVersion = async (args: readonly string[], context: IReleaseContext): Promise<number> => {
  const { stderr, env } = context
  if (args.length > 1 || args.some((arg) => arg !== DRY_RUN)) {
    stderr(`This command takes only ${DRY_RUN}; got ${args.join(' ')}.\n`)
    return WRONG_ARGUMENTS
  }
  const isDryRun = args.length === 1
  const output = outputFileOf(env)
  if (!isDryRun && env.GITHUB_ACTIONS === 'true' && output === undefined) {
    stderr(
      'GITHUB_OUTPUT is not set; under GitHub Actions the release command writes the version to the file it names.\n'
    )
    return 1
  }
  const decided = await decide(isDryRun, context)
  if (typeof decided === 'number') {
    return decided
  }
  if (!isDryRun && output !== undefined) {
    await appendFile(output, `version=${decided ?? ''}\n`)
  }
  return 0
}
