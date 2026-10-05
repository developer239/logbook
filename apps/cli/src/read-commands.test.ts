import { join } from 'node:path'
import { REPORT_TOPICS, SESSION_GOALS, SESSION_OUTCOMES, type IReadOperations } from '@log-book/engine'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReadRunners } from './read-commands.js'
import { runCli } from './run-cli.js'

interface IRun {
  code: number
  stdout: string
  stderr: string
}

interface IStandIn {
  read: IReadOperations
  calls: () => Record<string, unknown[][]>
}

const HOME = '/home/example'
const ANSWER = '# Example answer'

const standInRead = (): IStandIn => {
  const read = {
    sessions: vi.fn<IReadOperations['sessions']>().mockResolvedValue(ANSWER),
    search: vi.fn<IReadOperations['search']>().mockResolvedValue(ANSWER),
    tree: vi.fn<IReadOperations['tree']>().mockResolvedValue(ANSWER),
    timeline: vi.fn<IReadOperations['timeline']>().mockResolvedValue(ANSWER),
    report: vi.fn<IReadOperations['report']>().mockResolvedValue(ANSWER),
    sql: vi.fn<IReadOperations['sql']>().mockResolvedValue(ANSWER),
  }
  const calls = (): Record<string, unknown[][]> =>
    Object.fromEntries(
      Object.entries(read)
        .map(([name, mock]) => [name, mock.mock.calls as unknown[][]] as const)
        .filter(([, made]) => made.length > 0)
    )
  return { read, calls }
}

const run = async (argv: readonly string[], read?: IReadOperations): Promise<IRun> => {
  let stdout = ''
  let stderr = ''
  const code = await runCli(
    {
      argv,
      env: {},
      home: HOME,
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      signal: new AbortController().signal,
    },
    read === undefined ? createReadRunners() : createReadRunners(() => read)
  )
  return { code, stdout, stderr }
}

const harnessRow = (id: string, alias: string): Record<string, string | number> => ({
  id,
  name: `Example ${id}`,
  default_agent: 'build',
  filter_alias: alias,
  is_found: 1,
  checked_at: 1,
  location_variables: '[]',
})

let warehouse: ITestWarehouse

beforeEach(async () => {
  warehouse = await createTestWarehouse()
  insert(warehouse.db, 'harness', harnessRow('claude-code', 'claude'))
  insert(warehouse.db, 'harness', harnessRow('opencode', 'opencode'))
  // A harness whose adapter this build no longer registers keeps its row.
  insert(warehouse.db, 'harness', harnessRow('example-gone', 'gone'))
  vi.stubEnv('LOGBOOK_DB', warehouse.path)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await warehouse.remove()
})

describe('the read commands', () => {
  describe('their engine calls', () => {
    it.each([
      [
        'sessions with every filter',
        [
          'sessions',
          '--harness',
          'claude',
          '--origin',
          'scripted',
          '--project',
          'example',
          '--goal',
          SESSION_GOALS[0],
          '--outcome',
          SESSION_OUTCOMES[0],
          '--since',
          '2026-01-02',
          '--limit',
          '5',
        ],
        {
          sessions: [
            [
              {
                harness: 'claude',
                origin: 'scripted',
                project: 'example',
                goal: SESSION_GOALS[0],
                outcome: SESSION_OUTCOMES[0],
                since: new Date(2026, 0, 2).getTime(),
                limit: 5,
              },
            ],
          ],
        },
      ],
      ['sessions without options', ['sessions'], { sessions: [[{ limit: 30 }]] }],
      ['search', ['search', 'example words', '--limit', '3'], { search: [['example words', { limit: 3 }]] }],
      ['tree', ['tree', 'example-session'], { tree: [['example-session', { isFromRoot: false }]] }],
      [
        'tree from its root',
        ['tree', 'example-session', '--root'],
        { tree: [['example-session', { isFromRoot: true }]] },
      ],
      ['timeline', ['timeline', 'example-session'], { timeline: [['example-session']] }],
      ['report without a name', ['report'], { report: [['all', { maxRows: 200 }]] }],
      [
        'report of a topic',
        ['report', REPORT_TOPICS[0], '--max-rows', '5'],
        { report: [[REPORT_TOPICS[0], { maxRows: 5 }]] },
      ],
      ['sql', ['sql', 'SELECT 1 AS example'], { sql: [['SELECT 1 AS example', { maxRows: 200 }]] }],
    ])('passes the options and positionals of %s and prints the answer', async (_case, argv, expected) => {
      // Arrange
      const standIn = standInRead()

      // Act
      const result = await run(argv, standIn.read)

      // Assert
      expect(result).toStrictEqual({ code: 0, stdout: `${ANSWER}\n`, stderr: '' })
      expect(standIn.calls()).toStrictEqual(expected)
    })
  })

  describe('--harness', () => {
    it.each(['claude-code', 'claude', 'example-gone'])('accepts %s from the harness rows', async (harness) => {
      // Arrange
      const standIn = standInRead()

      // Act
      const result = await run(['sessions', '--harness', harness], standIn.read)

      // Assert
      expect(result.code).toBe(0)
      expect(standIn.calls()).toStrictEqual({ sessions: [[{ harness, limit: 30 }]] })
    })

    it('refuses another value with the choice line, each value once, without calling the engine', async () => {
      // Arrange
      const standIn = standInRead()

      // Act
      const result = await run(['sessions', '--harness', 'codex'], standIn.read)

      // Assert
      expect(result).toStrictEqual({
        code: 2,
        stdout: '',
        stderr: '--harness must be one of: claude-code, claude, opencode, example-gone, gone; got codex\n',
      })
      expect(standIn.calls()).toStrictEqual({})
    })
  })

  describe('through the engine', () => {
    it('answers sql over the warehouse', async () => {
      // Act
      const result = await run(['sql', 'SELECT count(*) AS n FROM harness'])

      // Assert
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('| 3 |')
    })

    it("ends sql with a write statement at exit 1 with SQLite's message last", async () => {
      // Act
      const result = await run(['sql', 'DELETE FROM session'])

      // Assert
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/readonly database\n$/u)
    })

    it('ends a read command at exit 1 with the missing-warehouse line before any sync', async () => {
      // Arrange
      const missing = join(warehouse.path, '..', 'missing.db')
      vi.stubEnv('LOGBOOK_DB', missing)

      // Act
      const result = await run(['sessions'])

      // Assert
      expect(result).toStrictEqual({
        code: 1,
        stdout: '',
        stderr: `No warehouse at ${missing} yet. Run logbook sync or start logbook first.\n`,
      })
    })
  })
})
