import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanPurity } from './purity.js'

const PLANTED_PLAN = [
  "import { readFileSync } from 'node:fs'",
  "import os from 'os'",
  "import { execFile } from 'node:child_process'",
  'export const home = process.env.HOME',
  'export const now = Date.now()',
  'export const today = new Date()',
  "export const parsed = new Date('2026-01-02')",
  'export const built = new Date(2026, 0, 2)',
  "export const stamp = Date.parse('2026-01-02')",
  'export const roll = Math.random()',
  'export const hour = new Date(0).getHours() + new Date(0).getTimezoneOffset()',
  'new Date(0).setMinutes(1)',
  'export const label = new Date(0).toLocaleDateString()',
  'export const text = (42).toString(16)',
  "export const format = new Intl.NumberFormat('en')",
  "export const order = 'a'.localeCompare('b')",
].join('\n')

const PLANTED_CORPUS = ['// Date.now() in a comment is clean', `export const value = \`\${String(Date.now())}\``].join(
  '\n'
)

const CLEAN = [
  'export const utc = Date.UTC(2026, 0, 2)',
  'export const hours = new Date(0).getUTCHours()',
  'export const iso = new Date(0).toISOString()',
  'export const epoch = new Date(0)',
  "export const prose = 'Date.now() and new Date() and process.env only as text'",
  `export const template = \`Math.random() \${String(epoch.getTime())} toString()\``,
  "import { join } from 'node:path'",
].join('\n')

const TEST_FILE = "import { readFileSync } from 'node:fs'\nexport const now = Date.now()\n"

const plant = async (root: string, files: Record<string, string>): Promise<void> => {
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), content)
    })
  )
}

describe('scanPurity', () => {
  let root = ''

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reports each planted banned use with its file and line, skipping test files and clean uses', async () => {
    // Arrange
    root = await mkdtemp(join(tmpdir(), 'logbook-purity-'))
    await plant(root, {
      'src/plan/planted.ts': PLANTED_PLAN,
      'src/plan/nested/planted.test.ts': TEST_FILE,
      'src/corpus/texts/planted.ts': PLANTED_CORPUS,
      'src/corpus/clean.ts': CLEAN,
      'src/random.ts': CLEAN,
      'src/outside.ts': TEST_FILE,
    })

    // Act
    const findings = await scanPurity(root)

    // Assert
    expect(findings).toStrictEqual([
      { file: 'src/corpus/texts/planted.ts', line: 2, api: 'Date.now' },
      { file: 'src/plan/planted.ts', line: 1, api: 'node:fs' },
      { file: 'src/plan/planted.ts', line: 2, api: 'node:os' },
      { file: 'src/plan/planted.ts', line: 3, api: 'node:child_process' },
      { file: 'src/plan/planted.ts', line: 4, api: 'process.env' },
      { file: 'src/plan/planted.ts', line: 5, api: 'Date.now' },
      { file: 'src/plan/planted.ts', line: 6, api: 'new Date()' },
      { file: 'src/plan/planted.ts', line: 7, api: 'new Date(<string>)' },
      { file: 'src/plan/planted.ts', line: 8, api: 'new Date(<fields>)' },
      { file: 'src/plan/planted.ts', line: 9, api: 'Date.parse' },
      { file: 'src/plan/planted.ts', line: 10, api: 'Math.random' },
      { file: 'src/plan/planted.ts', line: 11, api: 'getHours' },
      { file: 'src/plan/planted.ts', line: 11, api: 'getTimezoneOffset' },
      { file: 'src/plan/planted.ts', line: 12, api: 'setMinutes' },
      { file: 'src/plan/planted.ts', line: 13, api: 'toLocaleDateString' },
      { file: 'src/plan/planted.ts', line: 14, api: 'toString' },
      { file: 'src/plan/planted.ts', line: 15, api: 'Intl' },
      { file: 'src/plan/planted.ts', line: 16, api: 'localeCompare' },
    ])
  })

  it('finds nothing when the scanned directories do not exist yet', async () => {
    // Arrange
    root = await mkdtemp(join(tmpdir(), 'logbook-purity-'))
    await plant(root, { 'src/random.ts': CLEAN })

    // Act
    const findings = await scanPurity(root)

    // Assert
    expect(findings).toStrictEqual([])
  })
})
