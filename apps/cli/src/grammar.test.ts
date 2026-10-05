import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { typeScriptChildArgs } from '@log-book/engine/testing'
import { describe, expect, it } from 'vitest'
import { COMMANDS, ENVIRONMENT, EXIT_CODES, parseCommandLine } from './grammar.js'

const run = promisify(execFile)
const REPOSITORY = fileURLToPath(new URL('../../..', import.meta.url))
const GRAMMAR = pathToFileURL(fileURLToPath(new URL('grammar.ts', import.meta.url))).href

// Imports the module, then shows the sandbox holds: a read outside the repository and a spawn are both refused.
const SANDBOXED_IMPORT = `
const grammar = await import(${JSON.stringify(GRAMMAR)})
const { readFile } = await import('node:fs/promises')
const { execFileSync } = await import('node:child_process')
const refused = async (attempt) => {
  try {
    await attempt()
    return 'allowed'
  } catch (error) {
    return error.code
  }
}
console.log(JSON.stringify({
  commands: grammar.COMMANDS.length,
  read: await refused(() => readFile('/etc/hosts')),
  spawn: await refused(() => execFileSync(process.execPath, ['-e', ''])),
}))
`

const rows = (name: string): typeof ENVIRONMENT => ENVIRONMENT.filter((variable) => variable.name === name)

const lineOf = (argv: readonly string[]): string | null => {
  const parsed = parseCommandLine(argv)
  return parsed.kind === 'usage-error' ? parsed.line : null
}

describe('the command table', () => {
  it('imports in a process that may read only the repository and may neither write nor start a process', async () => {
    // Arrange: the sandbox matches real paths, and the temporary directory may sit behind a symbolic link
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'cli-grammar-')))

    try {
      // Act
      const { stdout } = await run(process.execPath, [
        ...(await typeScriptChildArgs(directory)),
        '--permission',
        `--allow-fs-read=${REPOSITORY}`,
        `--allow-fs-read=${directory}`,
        '--input-type=module',
        '-e',
        SANDBOXED_IMPORT,
      ])

      // Assert
      expect(JSON.parse(stdout) as unknown).toStrictEqual({
        commands: 17,
        read: 'ERR_ACCESS_DENIED',
        spawn: 'ERR_ACCESS_DENIED',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('holds the 17 commands in order, each with its options and the exit codes it raises', () => {
    // Act
    const commands = COMMANDS.map((command) => ({
      words: command.words.join(' '),
      options: command.options.map((option) => option.name),
      raisesUsageErrors: command.exitCodes.includes('usage error'),
    }))

    // Assert
    expect(commands).toStrictEqual([
      { words: 'start', options: ['port', 'no-open', 'interval', 'no-sync'], raisesUsageErrors: true },
      { words: 'sync', options: [], raisesUsageErrors: true },
      {
        words: 'sessions',
        options: ['harness', 'origin', 'project', 'goal', 'outcome', 'since', 'limit'],
        raisesUsageErrors: true,
      },
      { words: 'search', options: ['limit'], raisesUsageErrors: true },
      { words: 'tree', options: ['root'], raisesUsageErrors: true },
      { words: 'timeline', options: [], raisesUsageErrors: true },
      { words: 'report', options: ['max-rows'], raisesUsageErrors: true },
      { words: 'sql', options: ['max-rows'], raisesUsageErrors: true },
      { words: 'labels update', options: ['model'], raisesUsageErrors: true },
      { words: 'labels run', options: ['task', 'model', 'sample', 'limit'], raisesUsageErrors: true },
      { words: 'labels plan', options: ['model'], raisesUsageErrors: true },
      { words: 'labels preview', options: ['task', 'batches'], raisesUsageErrors: true },
      { words: 'labels compare', options: ['task', 'first', 'second'], raisesUsageErrors: true },
      { words: 'labels drop', options: ['task', 'labeller'], raisesUsageErrors: true },
      { words: 'forget', options: ['project'], raisesUsageErrors: true },
      { words: 'compact', options: [], raisesUsageErrors: true },
      { words: 'doctor', options: [], raisesUsageErrors: true },
    ])
  })

  it('holds the 12 exit codes with their names', () => {
    // Act
    const codes = EXIT_CODES.map(({ code, name }) => [code, name])

    // Assert
    expect(codes).toStrictEqual([
      [0, 'success'],
      [1, 'failure'],
      [2, 'usage error'],
      [3, 'already running'],
      [4, 'port in use'],
      [5, 'unsupported environment'],
      [6, 'newer warehouse'],
      [7, 'missing prerequisite'],
      [8, 'usage limit'],
      [9, 'updated while running'],
      [10, 'partial failure'],
      [130, 'interrupted'],
    ])
  })

  it("lists each adapter's location variables, and XDG_DATA_HOME once with Log Book's and OpenCode's effects", () => {
    // Act
    // Assert
    expect({
      adapters: ['CLAUDE_CONFIG_DIR', 'OPENCODE_DB', 'OPENCODE_DISABLE_CHANNEL_DB'].map((name) =>
        rows(name).map((row) => row.effects.map((effect) => effect.by))
      ),
      dataHome: rows('XDG_DATA_HOME').map((row) => row.effects.map((effect) => effect.by)),
    }).toStrictEqual({
      adapters: [[['Claude Code']], [['OpenCode']], [['OpenCode']]],
      dataHome: [['Log Book', 'OpenCode']],
    })
  })
})

describe('parseCommandLine', () => {
  it.each([
    [['labels', 'group'], 'Unknown command: labels group. Run logbook --help for the commands.'],
    [['labels', 'verdict'], 'Unknown command: labels verdict. Run logbook --help for the commands.'],
    [['export-phoenix'], 'Unknown command: export-phoenix. Run logbook --help for the commands.'],
    [['--open'], 'Unknown option --open for logbook start. Run logbook start --help for its options.'],
    [['sync', 'now'], 'sync takes no argument.'],
    [['search'], 'search takes one <query>.'],
    [['labels', 'preview'], 'labels preview needs --task <task>.'],
    [['sessions', '--limit', '0'], '--limit must be a positive integer, got 0'],
    [['sessions', '--since', '2026-13-01'], '--since must be a date as YYYY-MM-DD, got 2026-13-01'],
    [
      ['labels', 'run', '--task', 'nope'],
      '--task must be one of: shell, tool-failure, session, outcome, prompt, reply; got nope',
    ],
    [['--port', '70000'], '--port must be a whole number from 0 to 65535, got 70000'],
    [
      ['labels', 'preview', '--task', 'shell', '--batches', '11'],
      '--batches must be a whole number from 1 to 10, got 11',
    ],
    [
      ['labels', 'update', '--model', '-x'],
      '--model must start with a letter or digit and hold only letters, digits, . _ - : or @ (at most 128 characters), got "-x"',
    ],
    [
      ['forget', 'claude-code:example', '--project', '/tmp/x'],
      'forget takes session ids or --project <dir>, not both.',
    ],
    [['forget'], 'forget needs session ids or --project <dir>.'],
    [
      ['labels', 'drop', '--task', 'shell', '--labeller', 'rules'],
      "The rules-based labels are rebuilt on every sync; only a model's labels can be dropped.",
    ],
  ])('refuses %j with its line', (argv, line) => {
    // Act
    const refused = lineOf(argv)

    // Assert
    expect(refused).toBe(line)
  })

  it('labels with claude-haiku-4-5 without --model and takes claude-sonnet-5-5 when given', () => {
    // Act
    const [plain, sonnet] = [
      ['labels', 'update'],
      ['labels', 'update', '--model', 'claude-sonnet-5-5'],
    ].map((argv) => parseCommandLine(argv))

    // Assert
    expect([plain, sonnet]).toStrictEqual([
      { kind: 'command', command: 'labels update', values: { model: 'claude-haiku-4-5' }, positionals: [] },
      { kind: 'command', command: 'labels update', values: { model: 'claude-sonnet-5-5' }, positionals: [] },
    ])
  })

  it.each([[''], ['has space'], ['-x'], ['m'.repeat(129)]])('refuses the model %j', (model) => {
    // Act
    const parsed = parseCommandLine(['labels', 'run', '--task', 'shell', '--model', model])

    // Assert
    expect(parsed.kind).toBe('usage-error')
  })

  it.each([
    [['--port', '0'], true],
    [['--port', '65535'], true],
    [['--port', '-1'], false],
    [['--port', '65536'], false],
    [['--interval', '0'], false],
    [['labels', 'preview', '--task', 'shell', '--batches', '0'], false],
    [['labels', 'preview', '--task', 'shell', '--batches', '11'], false],
  ])('accepts %j: %s', (argv, isAccepted) => {
    // Act
    const parsed = parseCommandLine(argv)

    // Assert
    expect(parsed.kind === 'command').toBe(isAccepted)
  })

  it('parses a bare logbook and one with only start options as start, with the defaults', () => {
    // Act
    const [bare, options] = [[], ['--port', '7315', '--no-open']].map((argv) => parseCommandLine(argv))

    // Assert
    expect([bare, options]).toStrictEqual([
      {
        kind: 'command',
        command: 'start',
        values: { 'port': 7314, 'no-open': false, 'interval': 5, 'no-sync': false },
        positionals: [],
      },
      {
        kind: 'command',
        command: 'start',
        values: { 'port': 7315, 'no-open': true, 'interval': 5, 'no-sync': false },
        positionals: [],
      },
    ])
  })

  it('answers --help and --version, for logbook and for a command', () => {
    // Act
    const parsed = [['--help'], ['-v'], ['labels', 'run', '--help'], ['sync', '-h']].map((argv) =>
      parseCommandLine(argv)
    )

    // Assert
    expect(parsed).toStrictEqual([
      { kind: 'help', command: null },
      { kind: 'version' },
      { kind: 'help', command: 'labels run' },
      { kind: 'help', command: 'sync' },
    ])
  })

  it('types the values of a command with options and positionals', () => {
    // Act
    const parsed = parseCommandLine(['sessions', '--origin', 'scripted', '--since', '2024-02-29', '--limit', '5'])

    // Assert
    expect(parsed).toStrictEqual({
      kind: 'command',
      command: 'sessions',
      values: { origin: 'scripted', since: '2024-02-29', limit: 5 },
      positionals: [],
    })
  })
})
