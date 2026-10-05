import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import type { Reporter, TestModule, Vitest } from 'vitest/node'

// Every Vitest run in GitHub Actions gets a section of the job summary: each test layer's time against specification
// 11's budget, the run against its target, and the slowest files. Budgets are targets, never assertions: the section
// never changes a run's result.

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const SLOWEST_SHOWN = 10
const OVER_BUDGET = 'over budget'

interface ILayer {
  order: number
  name: string
  // Null for a layer whose targets another specification sets.
  budgetMs: number | null
}

const LAYERS: readonly (readonly [RegExp, ILayer])[] = [
  [
    /^packages\/adapter-[^/]+\/src\/(?:conformance\/)?conformance\.test\.ts$/u,
    { order: 2, name: '2, conformance', budgetMs: 20 * SECOND_MS },
  ],
  [/^packages\/warehouse\/src\//u, { order: 3, name: '3, warehouse and migration', budgetMs: 20 * SECOND_MS }],
  [/^packages\/engine\/src\//u, { order: 4, name: '4, engine', budgetMs: 60 * SECOND_MS }],
  [/^apps\/web\//u, { order: 5, name: '5, web', budgetMs: 50 * SECOND_MS }],
  [/^apps\/cli\/test\/composition\//u, { order: 6, name: '6, composition', budgetMs: 20 * SECOND_MS }],
  [/^apps\/cli\/test\/e2e\//u, { order: 7, name: '7, end to end', budgetMs: 4 * MINUTE_MS }],
  [/^packages\/demo\/test\//u, { order: 8, name: 'demo build checks', budgetMs: null }],
]
const UNIT: ILayer = { order: 1, name: '1, unit', budgetMs: 30 * SECOND_MS }

// A test file's layer, from its repository-relative path.
export const layerOf = (path: string): ILayer => LAYERS.find(([pattern]) => pattern.test(path))?.[1] ?? UNIT

export interface IFileTime {
  // Repository-relative.
  file: string
  project: string
  tests: number
  startMs: number
  endMs: number
}

export interface IRunTimes {
  projects: readonly string[]
  files: readonly IFileTime[]
  startMs: number
  endMs: number
}

// The run's target: `pnpm test` under 3 minutes, `pnpm test:e2e` under 4; the demo and browser runs have none here.
const targetOf = (projects: readonly string[]): number | null => {
  if (projects.length === 1 && projects[0] === 'e2e') {
    return 4 * MINUTE_MS
  }
  const isOwnTargets =
    projects.length > 0 && projects.every((project) => project === 'demo-build' || project === 'docs-browser')
  return isOwnTargets ? null : 3 * MINUTE_MS
}

const seconds = (ms: number): string => `${(ms / SECOND_MS).toFixed(1)} s`

const budget = (ms: number): string =>
  ms >= 2 * MINUTE_MS ? `${String(ms / MINUTE_MS)} min` : `${String(ms / SECOND_MS)} s`

const against = (ms: number, budgetMs: number | null): string => {
  if (budgetMs === null) {
    return 'none'
  }
  return ms > budgetMs ? `${budget(budgetMs)}, ${OVER_BUDGET}` : budget(budgetMs)
}

const layerRows = (files: readonly IFileTime[]): string[][] => {
  const byLayer = new Map<string, { layer: ILayer; files: IFileTime[] }>()
  for (const file of files) {
    const layer = layerOf(file.file)
    byLayer.set(layer.name, { layer, files: [...(byLayer.get(layer.name)?.files ?? []), file] })
  }
  return [...byLayer.values()]
    .toSorted((left, right) => left.layer.order - right.layer.order)
    .map(({ layer, files: layerFiles }) => {
      const wallMs =
        Math.max(...layerFiles.map((file) => file.endMs)) - Math.min(...layerFiles.map((file) => file.startMs))
      const tests = layerFiles.reduce((sum, file) => sum + file.tests, 0)
      return [layer.name, String(layerFiles.length), String(tests), seconds(wallMs), against(wallMs, layer.budgetMs)]
    })
}

const table = (headers: readonly string[], rows: readonly (readonly string[])[]): string[] => [
  `| ${headers.join(' | ')} |`,
  `| ${headers.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.join(' | ')} |`),
]

// One run's section of the job summary, in Markdown.
export const renderSection = (run: IRunTimes): string => {
  const slowest = run.files
    .toSorted((left, right) => right.endMs - right.startMs - (left.endMs - left.startMs))
    .slice(0, SLOWEST_SHOWN)
  const runMs = run.endMs - run.startMs
  return [
    `### Test times: ${run.projects.join(', ')}`,
    '',
    ...table(['Layer', 'Files', 'Tests', 'Wall clock', 'Budget'], layerRows(run.files)),
    '',
    `**Run:** ${seconds(runMs)} against ${against(runMs, targetOf(run.projects))}`,
    '',
    '**Slowest files**',
    '',
    ...table(
      ['File', 'Project', 'Time'],
      slowest.map((file) => [file.file, file.project, seconds(file.endMs - file.startMs)])
    ),
    '',
  ].join('\n')
}

// The file GitHub Actions shows as the job summary; a run there without it stops, since a summary written nowhere
// would go unnoticed.
export const summaryPathOf = (environment: NodeJS.ProcessEnv): string => {
  const path = environment.GITHUB_STEP_SUMMARY ?? ''
  if (path === '') {
    throw new Error('GITHUB_ACTIONS is true but GITHUB_STEP_SUMMARY is not set: the test times have nowhere to go.')
  }
  return path
}

// Appends, so each Vitest run of a job keeps its own section beside the others and beside the report Vitest's own
// github-actions reporter writes there; the blank line keeps the heading off the text before it.
export const appendSection = (path: string, section: string): void => {
  appendFileSync(path, `\n${section}\n`)
}

const testsOf = (testModule: TestModule): number => [...testModule.children.allTests()].length

export class BudgetSummaryReporter implements Reporter {
  private readonly path: string
  private root = ''
  private projects: string[] = []
  private readonly starts = new Map<string, number>()
  private readonly files: IFileTime[] = []
  private readonly now: () => number
  private startMs: number

  // `now` is the clock, which the tests set.
  constructor(environment: NodeJS.ProcessEnv, now: () => number = Date.now) {
    this.path = summaryPathOf(environment)
    this.now = now
    this.startMs = now()
  }

  public readonly onInit = (vitest: Vitest): void => {
    this.root = vitest.config.root
    this.projects = vitest.projects.map((project) => project.name)
    this.startMs = this.now()
  }

  public readonly onTestModuleStart = (testModule: TestModule): void => {
    this.starts.set(testModule.moduleId, this.now())
  }

  public readonly onTestModuleEnd = (testModule: TestModule): void => {
    this.files.push({
      file: relative(this.root, testModule.moduleId),
      project: testModule.project.name,
      tests: testsOf(testModule),
      startMs: this.starts.get(testModule.moduleId) ?? this.startMs,
      endMs: this.now(),
    })
  }

  public readonly onTestRunEnd = (): void => {
    appendSection(
      this.path,
      renderSection({ projects: this.projects, files: this.files, startMs: this.startMs, endMs: this.now() })
    )
  }
}
