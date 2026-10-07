import type { ICommandSpec, IEnvironmentVariable, IExitCode, IOptionSpec } from '@log-book/cli/grammar'
import { describe, expect, it } from 'vitest'
import { cliPage, environmentPage, exitCodesPage, modelOptionPage, schemaPage } from './reference.js'

const option = (fields: Partial<IOptionSpec> & Pick<IOptionSpec, 'name' | 'help'>): IOptionSpec => ({
  placeholder: '<n>',
  kind: 'integer',
  default: null,
  min: null,
  max: null,
  values: null,
  isRequired: false,
  forbidden: null,
  ...fields,
})

const command = (words: readonly string[], options: readonly IOptionSpec[]): ICommandSpec => ({
  words,
  synopsis: `logbook ${words.join(' ')}`,
  summary: `The ${words.join(' ')} summary`,
  description: `The ${words.join(' ')} description`,
  positionals: [],
  options,
  isWriting: false,
  exitCodes: ['success'],
  forms: null,
  tables: null,
})

const MODEL = option({
  name: 'model',
  placeholder: '<model>',
  kind: 'model',
  default: 'model-a',
  help: 'Model A agrees 62%',
})
const COMMANDS: readonly ICommandSpec[] = [
  command(['start'], [option({ name: 'port', default: 7314, help: 'The port' })]),
  command(['labels', 'update'], [MODEL]),
]
const EXIT_CODES: readonly IExitCode[] = [
  { code: 0, name: 'success', meaning: 'It worked', raisedBy: 'all' },
  { code: 2, name: 'usage error', meaning: 'A bad option', raisedBy: 'all' },
]

const withTables = (tables: string | null): readonly ICommandSpec[] => [{ ...command(['sql'], []), tables }]

const optionRows = (page: string): string[] => page.split('\n').filter((line) => line.startsWith('| `--'))

describe('cliPage', () => {
  it('gives an added command its own section', () => {
    // Act
    const page = cliPage([...COMMANDS, command(['sweep'], [])], EXIT_CODES)

    // Assert
    expect(page.split('\n').filter((line) => line.startsWith('## logbook'))).toStrictEqual([
      '## logbook start',
      '## logbook labels update',
      '## logbook sweep',
    ])
  })

  it('shows a renamed flag and a changed default in its options table', () => {
    // Arrange
    const changed = [command(['start'], [option({ name: 'listen-port', default: 8000, help: 'The port' })])]

    // Act
    const [before, after] = [cliPage(COMMANDS.slice(0, 1), EXIT_CODES), cliPage(changed, EXIT_CODES)]

    // Assert
    expect({ before: optionRows(before), after: optionRows(after) }).toStrictEqual({
      before: ['| `--port` | `<n>` | `7314` | The port |'],
      after: ['| `--listen-port` | `<n>` | `8000` | The port |'],
    })
  })

  it('carries a changed --model help line into the CLI page and the model option part alike', () => {
    // Arrange
    const changed = [COMMANDS[0], command(['labels', 'update'], [{ ...MODEL, help: 'Model B agrees 70%' }])].filter(
      (each) => each !== undefined
    )

    // Act
    const [page, part] = [cliPage(changed, EXIT_CODES), modelOptionPage(changed)]

    // Assert
    expect({ inPage: page.includes('Model B agrees 70%'), part }).toStrictEqual({
      inPage: true,
      part: 'Model B agrees 70%\n',
    })
  })

  it('shows the description without the summary, which only logbook --help lists', () => {
    // Act
    const page = cliPage(COMMANDS.slice(0, 1), EXIT_CODES)

    // Assert
    expect({
      summary: page.includes('The start summary'),
      description: page.includes('The start description'),
    }).toStrictEqual({ summary: false, description: true })
  })

  it('links the tables of a command that prints them to the schema page, instead of listing them', () => {
    // Arrange
    const sql = { ...command(['sql'], []), tables: 'Times are UTC.\nitem(id, name) - one row per item;' }

    // Act
    const page = cliPage([sql], EXIT_CODES)

    // Assert
    expect({
      link: page.includes('[Database schema](/reference/schema)'),
      table: page.includes('item(id'),
    }).toStrictEqual({ link: true, table: false })
  })

  it('links each exit code a command raises to its row', () => {
    // Act
    const page = cliPage(COMMANDS.slice(0, 1), EXIT_CODES)

    // Assert
    expect(page).toContain('**Exit codes:** [0 success](/reference/exit-codes#success)')
  })
})

describe('environmentPage', () => {
  it('leaves internal variables out and gives a variable read by Log Book and an adapter one row with both effects', () => {
    // Arrange
    const environment: readonly IEnvironmentVariable[] = [
      {
        name: 'XDG_DATA_HOME',
        effects: [
          { by: 'Log Book', changes: 'Its data directory' },
          { by: 'OpenCode', changes: 'Where OpenCode keeps its data' },
        ],
        default: '~/.local/share',
        isInternal: false,
      },
      { name: 'LOGBOOK_CLI', effects: [{ by: 'Log Book', changes: 'Set by a host' }], default: null, isInternal: true },
    ]

    // Act
    const page = environmentPage(environment)

    // Assert
    expect(page.split('\n').slice(2)).toStrictEqual([
      '| `XDG_DATA_HOME` | Log Book: Its data directory<br>OpenCode: Where OpenCode keeps its data | ~/.local/share |',
      '',
    ])
  })
})

describe('exitCodesPage', () => {
  it("joins each code's written what to do to its row", () => {
    // Act
    const page = exitCodesPage(EXIT_CODES, { 0: 'Nothing.', 2: 'Check the options.' })

    // Assert
    expect(page.split('\n').slice(2, 4)).toStrictEqual([
      '| <span id="success">0</span> | success | It worked | all | Nothing. |',
      '| <span id="usage-error">2</span> | usage error | A bad option | all | Check the options. |',
    ])
  })

  it.each([
    ['a code without what to do', { 0: 'Nothing.' }, 'Exit code 2 (usage error) has no written "what to do"'],
    [
      'what to do for a code the table lacks',
      { 0: 'Nothing.', 2: 'Check.', 9: 'Restart.' },
      'What to do is written for exit codes the table does not hold: 9',
    ],
  ])('refuses %s', (_case, whatToDo, message) => {
    // Act
    const page = (): string => exitCodesPage(EXIT_CODES, whatToDo)

    // Assert
    expect(page).toThrow(message)
  })
})

describe('schemaPage', () => {
  it('opens with the conventions, then gives each table its notes and a row per column', () => {
    // Arrange
    const tables = [
      'Times are UTC.',
      'item(id (the item id, unique), state open|closed) - one row per item;',
      'tag(item_id, name).',
    ].join('\n')

    // Act
    const page = schemaPage(withTables(tables))

    // Assert
    expect(page.split('\n')).toStrictEqual([
      'Times are UTC.',
      '',
      '## item',
      '',
      'One row per item.',
      '',
      '| Column | Notes |',
      '| --- | --- |',
      '| `id` | the item id, unique |',
      '| `state` | open\\|closed |',
      '',
      '## tag',
      '',
      '| Column | Notes |',
      '| --- | --- |',
      '| `item_id` |  |',
      '| `name` |  |',
      '',
    ])
  })

  it.each([
    [
      'a line that is not a table',
      'Times are UTC.\nnot a table',
      'A table line is not table(columns) - notes: not a table',
    ],
    ['a sql command without tables', null, 'logbook sql prints no tables'],
  ])('refuses %s', (_case, tables, message) => {
    // Act
    const page = (): string => schemaPage(withTables(tables))

    // Assert
    expect(page).toThrow(message)
  })
})
