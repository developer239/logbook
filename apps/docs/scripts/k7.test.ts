import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  COMMANDS,
  commandLineParser,
  EXIT_CODES,
  PACKAGE,
  parseCommandLine,
  type ICommandSpec,
} from '@log-book/cli/grammar'
import { afterEach, describe, expect, it } from 'vitest'
import { checkK7, findingLine, type IK7Inputs } from './k7.js'
import { cliPage, commandSlug } from './reference.js'
import { WHAT_TO_DO } from './what-to-do.js'

const directories: string[] = []

// A line that runs the next release on its own warehouse and port.
const npxLine = (port: number): string =>
  `LOGBOOK_DB="$HOME/logbook-next/warehouse.db" npx @log-book/cli@next --port ${String(port)} # own warehouse`

const block = (line: string): string => `Run it:\n\n\`\`\`sh\n${line}\n\`\`\`\n`

// A temporary repository holding a documentation package with an examples file for every command, and these files
// under its src.
const siteWith = async (
  files: Readonly<Record<string, string>>,
  commands: readonly ICommandSpec[] = COMMANDS
): Promise<string> => {
  const repository = await mkdtemp(join(tmpdir(), 'docs-k7-'))
  directories.push(repository)
  const examples = Object.fromEntries(
    commands.map((command) => [`reference/examples/${commandSlug(command)}.md`, `### Examples\n`])
  )
  await Promise.all(
    Object.entries({ ...examples, ...files }).map(async ([path, text]) => {
      const file = join(repository, 'apps', 'docs', 'src', path)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, text)
    })
  )
  return repository
}

const inputsFor = (repository: string, fields: Partial<IK7Inputs> = {}): IK7Inputs => ({
  docs: join(repository, 'apps', 'docs'),
  repository,
  commands: COMMANDS,
  exitCodes: EXIT_CODES,
  whatToDo: WHAT_TO_DO,
  parse: parseCommandLine,
  binary: PACKAGE.binary,
  packageName: PACKAGE.name,
  ...fields,
})

const linesOf = async (repository: string, fields: Partial<IK7Inputs> = {}): Promise<string[]> =>
  (await checkK7(inputsFor(repository, fields))).map(findingLine)

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('checkK7, the logbook lines of code blocks', () => {
  it('names the file, the line and the parser message of a line the parser refuses', async () => {
    // Arrange
    const repository = await siteWith({ 'guide.md': block('logbook labels preview --task shell --batches 11') })

    // Act
    const lines = await linesOf(repository)

    // Assert
    expect(lines).toStrictEqual(['K7 apps/docs/src/guide.md:4 --batches must be a whole number from 1 to 10, got 11'])
  })

  it('refuses an unknown option and passes an invented session id', async () => {
    // Arrange
    const repository = await siteWith({
      'unknown.md': block('logbook sessions --open'),
      'tree.md': block('logbook tree claude-code:de30da7a-0000-4000-8000-000000000001'),
    })

    // Act
    const lines = await linesOf(repository)

    // Assert
    expect(lines).toStrictEqual([
      'K7 apps/docs/src/unknown.md:4 Unknown option --open for logbook sessions. Run logbook sessions --help for its options.',
    ])
  })

  it('parses npx lines after their assignments and before their comment', async () => {
    // Arrange
    const repository = await siteWith({ 'good.md': block(npxLine(7316)), 'bad.md': block(npxLine(70_000)) })

    // Act
    const lines = await linesOf(repository)

    // Assert
    expect(lines).toStrictEqual(['K7 apps/docs/src/bad.md:4 --port must be a whole number from 0 to 65535, got 70000'])
  })

  it('reads no logbook line in prose or in a generated part', async () => {
    // Arrange
    const repository = await siteWith({
      'prose.md': 'Type logbook sessions --open to see nothing.\n',
      '.generated/cli.md': block('logbook sessions --open'),
    })

    // Act
    const lines = await linesOf(repository)

    // Assert
    expect(lines).toStrictEqual([])
  })

  it('refuses a guide line that a renamed flag left stale, while the generated reference shows the new name', async () => {
    // Arrange
    const renamed = COMMANDS.map((command) =>
      command.words.join(' ') === 'sessions'
        ? {
            ...command,
            options: command.options.map((option) => (option.name === 'limit' ? { ...option, name: 'max' } : option)),
          }
        : command
    )
    const repository = await siteWith({ 'guide.md': block('logbook sessions --limit 5') }, renamed)

    // Act
    const [reference, lines] = [
      cliPage(renamed, EXIT_CODES),
      await linesOf(repository, { commands: renamed, parse: commandLineParser(renamed) }),
    ]

    // Assert
    expect({ showsMax: reference.includes('| `--max` |'), lines }).toStrictEqual({
      showsMax: true,
      lines: [
        'K7 apps/docs/src/guide.md:4 Unknown option --limit for logbook sessions. Run logbook sessions --help for its options.',
      ],
    })
  })
})

describe('checkK7, the examples and the written what to do', () => {
  it('refuses an examples file for no command of the table', async () => {
    // Arrange
    const repository = await siteWith({ 'reference/examples/labels-group.md': '### Examples\n' })

    // Act
    const lines = await linesOf(repository)

    // Assert
    expect(lines).toStrictEqual([
      'K7 apps/docs/src/reference/examples/labels-group.md:1 labels-group.md gives examples of labels group, which is no command of the table',
    ])
  })

  it('refuses a command whose examples file is gone', async () => {
    // Arrange
    const others = COMMANDS.filter((command) => command.words.join(' ') !== 'doctor')
    const repository = await siteWith({}, others)

    // Act
    const lines = await linesOf(repository)

    // Assert
    expect(lines).toStrictEqual(['K7 apps/docs/src/reference/examples/doctor.md:1 logbook doctor has no examples file'])
  })

  it('refuses what to do for a code the table lacks, and a code without it', async () => {
    // Arrange
    const repository = await siteWith({})
    const { 10: _partialFailure, ...rest } = WHAT_TO_DO

    // Act
    const lines = await linesOf(repository, { whatToDo: { ...rest, 11: 'Wait.' } })

    // Assert
    expect(lines).toStrictEqual([
      'K7 apps/docs/scripts/what-to-do.ts:1 exit code 10 (partial failure) has no written what to do',
      'K7 apps/docs/scripts/what-to-do.ts:1 what to do is written for exit code 11, which the table does not hold',
    ])
  })
})
