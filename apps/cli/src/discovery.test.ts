import type { IAdapterEnvironment } from '@log-book/adapter-api'
import { inventedAdapter } from '@log-book/adapter-api/testing'
import { describe, expect, it } from 'vitest'
import { discoverAdapters, discoveryLines, warehouseLine, type ColumnWidth } from './discovery.js'

const HOME = '/home/example'

const environment = (variables: Record<string, string> = {}): IAdapterEnvironment => ({
  variables,
  homeDir: HOME,
  cwd: `${HOME}/work`,
  platform: 'linux',
})

const found = inventedAdapter({
  name: 'Example Agent',
  locate: {
    kind: 'found',
    root: '.example/sessions.db',
    describe: '~/.example/sessions.db (newest of 2 databases; set EXAMPLE_DB to choose)',
  },
})
const missingPath = inventedAdapter({
  name: 'Example Agent',
  locationVariables: ['EXAMPLE_DIR', 'EXAMPLE_DB'],
  locate: { kind: 'not-found', lookedAt: '.example/projects' },
})
const missingNoPath = inventedAdapter({
  name: 'Other Agent',
  locationVariables: ['OTHER_HOME', 'OTHER_DB'],
  locate: { kind: 'not-found', lookedAt: null },
})
const throwing = inventedAdapter({
  name: 'Other Agent',
  locate: { kind: 'throws', message: 'example locate defect' },
})

const linesFor = async (
  adapters: Parameters<typeof discoverAdapters>[0],
  width: ColumnWidth,
  env = environment()
): Promise<string[]> => discoveryLines(await discoverAdapters(adapters, env), width, env)

describe('the discovery lines', () => {
  it.each<[ColumnWidth, string]>([
    [13, 'Example Agent'],
    [12, 'Example Agent'],
  ])('words a found harness after its name in a column of %i', async (width) => {
    // Act
    const lines = await linesFor([found], width)

    // Assert
    expect(lines).toStrictEqual([
      `${'Example Agent'.padEnd(width - 1)} found at ~/.example/sessions.db (newest of 2 databases; set EXAMPLE_DB to choose)`,
    ])
  })

  it('pads each name to the column and lists the answers in registration order, at both widths', async () => {
    // Act
    const host = await linesFor(
      [missingPath, missingNoPath, throwing, found],
      13,
      environment({ OTHER_DB: ':memory:' })
    )
    const doctor = await linesFor([throwing, found], 12)

    // Assert
    expect({ host, doctor }).toStrictEqual({
      host: [
        'Example Agent not on this machine (no ~/.example/projects; set EXAMPLE_DIR if Example Agent keeps its data ' +
          'elsewhere)',
        'Other Agent  not on this machine (OTHER_DB is :memory:, so Other Agent keeps no history on disk)',
        'Other Agent  not checked, an adapter defect: example locate defect',
        'Example Agent found at ~/.example/sessions.db (newest of 2 databases; set EXAMPLE_DB to choose)',
      ],
      doctor: [
        'Other Agent not checked, an adapter defect: example locate defect',
        'Example Agent found at ~/.example/sessions.db (newest of 2 databases; set EXAMPLE_DB to choose)',
      ],
    })
  })

  it('skips an empty location variable and names none when none is set', async () => {
    // Act
    const lines = await linesFor([missingNoPath], 13, environment({ OTHER_HOME: '' }))

    // Assert
    expect(lines.slice(0, 1)).toStrictEqual(['Other Agent  not on this machine'])
  })

  it('follows the lines with the no-agent paragraph when nothing is found', async () => {
    // Act
    const lines = await linesFor([missingPath, missingNoPath], 13)

    // Assert
    expect(lines).toStrictEqual([
      'Example Agent not on this machine (no ~/.example/projects; set EXAMPLE_DIR if Example Agent keeps its data ' +
        'elsewhere)',
      'Other Agent  not on this machine',
      '',
      'No agent data found yet. Log Book reads what Example Agent and Other Agent keep on this machine; it will pick ' +
        'them up on the next sync once either has run here.',
    ])
  })

  it('leaves the paragraph out when one adapter found its data', async () => {
    // Act
    const lines = await linesFor([missingPath, found], 13)

    // Assert
    expect(lines).toHaveLength(2)
  })
})

describe('the warehouse line', () => {
  const path = `${HOME}/.local/share/log-book/warehouse.db`

  it.each([
    [{ previousVersion: 0, version: 1 }, 'Warehouse    ~/.local/share/log-book/warehouse.db, created at schema 1'],
    [
      { previousVersion: 1, version: 2 },
      'Warehouse    ~/.local/share/log-book/warehouse.db, migrated from schema 1 to 2',
    ],
    [{ previousVersion: 2, version: 2 }, 'Warehouse    ~/.local/share/log-book/warehouse.db, schema 2'],
  ])('words the open %j', (versions, expected) => {
    // Act
    const line = warehouseLine({ path, ...versions }, 13, HOME)

    // Assert
    expect(line).toBe(expected)
  })

  it('pads to the doctor column', () => {
    // Act
    const line = warehouseLine({ path, previousVersion: 2, version: 2 }, 12, HOME)

    // Assert
    expect(line).toBe('Warehouse   ~/.local/share/log-book/warehouse.db, schema 2')
  })
})
