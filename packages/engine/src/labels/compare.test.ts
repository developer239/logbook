import { existsSync } from 'node:fs'
import { ERROR_CODES } from '@log-book/core'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compareLabellers } from './compare.js'
import versions from './tasks/versions.json' with { type: 'json' }

const FIRST = 'claude-haiku-4-5'
const SECOND = 'claude-sonnet-5-5'

const label = (
  record: { type: string; id: string; labeller: string },
  name: string,
  value: string,
  version: number
): Record<string, string | number> => ({
  record_type: record.type,
  record_id: record.id,
  labeller: record.labeller,
  version,
  name,
  value,
  labelled_at: 1,
})

describe('compareLabellers', () => {
  let warehouse: ITestWarehouse | null = null

  const opened = (): ITestWarehouse => {
    if (warehouse === null) {
      throw new Error('The warehouse is not open.')
    }
    return warehouse
  }

  const arrange = (rows: readonly Record<string, string | number>[]): void => {
    for (const row of rows) {
      insert(opened().db, 'label', row)
    }
  }

  const compare = async (task: string): Promise<string> =>
    compareLabellers({ warehousePath: opened().path, task, first: FIRST, second: SECOND })

  beforeEach(async () => {
    warehouse = await createTestWarehouse()
  })

  afterEach(async () => {
    await warehouse?.remove()
    warehouse = null
  })

  it('counts agreement per field on the records both labelled, the commonest disagreement first', async () => {
    // Arrange
    const shell = (id: string, labeller: string, purpose: string): Record<string, string | number>[] => [
      label({ type: 'tool_call', id, labeller }, 'purpose', purpose, versions.shell),
      label({ type: 'tool_call', id, labeller }, 'failure', 'none', versions.shell),
    ]
    arrange([
      ...shell('c1', FIRST, 'run tests'),
      ...shell('c1', SECOND, 'run tests'),
      ...shell('c2', FIRST, 'run tests'),
      ...shell('c2', SECOND, 'read or search code'),
      ...shell('c3', FIRST, 'run tests'),
      ...shell('c3', SECOND, 'read or search code'),
      ...shell('c4', FIRST, 'edit files'),
      ...shell('c4', SECOND, 'write files'),
      // Labelled by one only: left out.
      ...shell('c5', FIRST, 'other'),
      // At an older version: left out.
      ...shell('c6', SECOND, 'other').map((row) => ({ ...row, version: versions.shell - 1 })),
      label({ type: 'tool_call', id: 'c6', labeller: FIRST }, 'purpose', 'other', versions.shell - 1),
    ])

    // Act
    const markdown = await compare('shell')

    // Assert
    expect(markdown.split('\n')).toStrictEqual([
      `# Labels: ${FIRST} against ${SECOND}`,
      '',
      '## purpose',
      '',
      '**Agreed:** 1 of 4 (25%)',
      '',
      `| ${FIRST} | ${SECOND} | records |`,
      '| --- | --- | --- |',
      '| run tests | read or search code | 2 |',
      '| edit files | write files | 1 |',
      '',
      '## failure',
      '',
      '**Agreed:** 4 of 4 (100%)',
      '',
    ])
  })

  it('compares a multi-code field as sets of codes, and reactions as the kinds per prompt', async () => {
    // Arrange
    arrange([
      label({ type: 'message', id: 'm1', labeller: FIRST }, 'reply', 'asks,permission', versions.reply),
      label({ type: 'message', id: 'm1', labeller: SECOND }, 'reply', 'permission,asks', versions.reply),
      label({ type: 'message', id: 'p1', labeller: FIRST }, 'act', 'continue', versions.prompt),
      label({ type: 'message', id: 'p1', labeller: SECOND }, 'act', 'continue', versions.prompt),
      label({ type: 'reaction', id: 'p1#1', labeller: FIRST }, 'reaction', 'correction', versions.prompt),
      label({ type: 'reaction', id: 'p1#1', labeller: SECOND }, 'reaction', 'praise', versions.prompt),
      label({ type: 'reaction', id: 'p1#2', labeller: SECOND }, 'reaction', 'correction', versions.prompt),
    ])

    // Act
    const [reply, prompt] = [await compare('reply'), await compare('prompt')]

    // Assert
    expect({
      reply: reply.split('\n').find((line) => line.startsWith('**Agreed')),
      reactions: prompt.split('\n').slice(prompt.split('\n').indexOf('## reaction set')),
    }).toStrictEqual({
      reply: '**Agreed:** 1 of 1 (100%)',
      reactions: [
        '## reaction set',
        '',
        '**Agreed:** 0 of 1 (0%)',
        '',
        `| ${FIRST} | ${SECOND} | records |`,
        '| --- | --- | --- |',
        '| correction | correction, praise | 1 |',
        '',
      ],
    })
  })

  it('refuses an unknown task, naming the six', async () => {
    // Act
    const comparing = compare('goals')

    // Assert
    await expect(comparing).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'No label task goals; pass one of shell, tool-failure, session, outcome, prompt, reply.',
    })
  })

  it('creates no lock file and changes no row', async () => {
    // Arrange
    arrange([label({ type: 'tool_call', id: 'c1', labeller: FIRST }, 'purpose', 'other', versions.shell)])

    // Act
    await compare('shell')

    // Assert
    expect({
      lockFiles: [existsSync(`${opened().path}.lock`), existsSync(`${opened().path}.labels.lock`)],
      labels: (opened().db.prepare('SELECT count(*) AS count FROM label').get() as { count: number }).count,
    }).toStrictEqual({ lockFiles: [false, false], labels: 1 })
  })
})
