import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendSection,
  BudgetSummaryReporter,
  layerOf,
  renderSection,
  summaryPathOf,
  type IFileTime,
} from './budget-summary.js'

const file = (path: string, project: string, startMs: number, endMs: number, tests = 2): IFileTime => ({
  file: path,
  project,
  tests,
  startMs,
  endMs,
})

describe('the budget summary', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'log-book-budget-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it.each([
    ['packages/adapter-opencode/src/conformance.test.ts', '2, conformance'],
    ['packages/adapter-api/src/conformance/conformance.test.ts', '2, conformance'],
    ['packages/warehouse/src/store.test.ts', '3, warehouse and migration'],
    ['packages/engine/src/sync/sync.test.ts', '4, engine'],
    ['apps/web/src/pages/index.test.ts', '5, web'],
    ['apps/cli/test/composition/sync.test.ts', '6, composition'],
    ['apps/cli/test/e2e/sync.e2e.test.ts', '7, end to end'],
    ['packages/demo/test/build.test.ts', 'demo build checks'],
    ['packages/core/src/clip-chars.test.ts', '1, unit'],
    ['packages/adapter-claude-code/src/session-builder.test.ts', '1, unit'],
  ])('maps %s to the layer %s', (path, layer) => {
    // Act
    const { name } = layerOf(path)

    // Assert
    expect(name).toBe(layer)
  })

  it('renders the rows, the wall clocks, the slowest files in order and the layers over budget', () => {
    // Arrange
    const files = [
      file('packages/core/src/a.test.ts', 'core', 0, 1_000),
      file('packages/core/src/b.test.ts', 'core', 500, 2_500, 3),
      file('packages/engine/src/c.test.ts', 'engine', 1_000, 62_000, 10),
      ...Array.from({ length: 9 }, (_file, index) =>
        file(`packages/warehouse/src/w${String(index)}.test.ts`, 'warehouse', 0, 100 + index, 1)
      ),
    ]

    // Act
    const section = renderSection({ projects: ['core', 'warehouse', 'engine'], files, startMs: 0, endMs: 63_000 })

    // Assert
    expect(section.split('\n')).toStrictEqual([
      '### Test times: core, warehouse, engine',
      '',
      '| Layer | Files | Tests | Wall clock | Budget |',
      '| --- | --- | --- | --- | --- |',
      '| 1, unit | 2 | 5 | 2.5 s | 30 s |',
      '| 3, warehouse and migration | 9 | 9 | 0.1 s | 20 s |',
      '| 4, engine | 1 | 10 | 61.0 s | 60 s, over budget |',
      '',
      '**Run:** 63.0 s against 3 min',
      '',
      '**Slowest files**',
      '',
      '| File | Project | Time |',
      '| --- | --- | --- |',
      '| packages/engine/src/c.test.ts | engine | 61.0 s |',
      '| packages/core/src/b.test.ts | core | 2.0 s |',
      '| packages/core/src/a.test.ts | core | 1.0 s |',
      ...[8, 7, 6, 5, 4, 3, 2].map(
        (index) => `| packages/warehouse/src/w${String(index)}.test.ts | warehouse | 0.1 s |`
      ),
      '',
    ])
  })

  it('marks a run over its target, the end-to-end run against 4 minutes', () => {
    // Act
    const section = renderSection({ projects: ['e2e'], files: [], startMs: 0, endMs: 5 * 60_000 })

    // Assert
    expect(section).toContain('**Run:** 300.0 s against 4 min, over budget')
  })

  it('appends to a summary that already holds text, leaving that text in place', async () => {
    // Arrange
    const path = join(directory, 'summary.md')
    await writeFile(path, '## Build\n\nGreen.\n')

    // Act
    appendSection(path, '### Test times: core\n')

    // Assert
    expect(await readFile(path, 'utf8')).toBe('## Build\n\nGreen.\n\n### Test times: core\n\n')
  })

  it('stops under GitHub Actions without GITHUB_STEP_SUMMARY, naming it', () => {
    // Act and Assert
    expect(() => summaryPathOf({ GITHUB_ACTIONS: 'true' })).toThrow(/GITHUB_STEP_SUMMARY/u)
  })

  it('leaves the exit code as the tests gave it when every time is over budget', async () => {
    // Arrange
    const path = join(directory, 'summary.md')
    const times = [0, 10 * 60_000]
    const reporter = new BudgetSummaryReporter({ GITHUB_STEP_SUMMARY: path }, () => times.shift() ?? 0)
    const { exitCode } = process

    // Act
    reporter.onTestRunEnd()

    // Assert
    expect({
      exitCode: process.exitCode,
      isOver: (await readFile(path, 'utf8')).includes('over budget'),
    }).toStrictEqual({
      exitCode,
      isOver: true,
    })
  })
})
