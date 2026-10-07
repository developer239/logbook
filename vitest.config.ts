import { defineConfig } from 'vitest/config'
import { BudgetSummaryReporter } from './test/budget-summary.js'

const UNIT_TIMEOUT_MS = 5_000
const ENGINE_TIMEOUT_MS = 10_000
const WAREHOUSE_TIMEOUT_MS = 15_000
const BROWSER_TIMEOUT_MS = 60_000
const E2E_TIMEOUT_MS = 60_000
const DEMO_BUILD_TIMEOUT_MS = 180_000

const E2E_TEST_FILES = '**/*.e2e.test.ts'
const EXCLUDED = ['**/node_modules/**', '**/dist/**']

interface IProjectSpec {
  name: string
  include: string[]
  exclude?: string[]
  timeout: number
  isSerial?: boolean
  // Runs before the project's own setup that builds the demo through the built CLI.
  isBuiltCliNeeded?: boolean
  // The project's own global setup, after the stale-build check.
  setup?: string
  // Keeps a stubbed environment variable for the rest of the file: a test helper that stubs it once in beforeAll
  // would otherwise lose it after the first test.
  isEnvStubKept?: boolean
  // Variables of this project's test processes on top of the root's.
  env?: Readonly<Record<string, string>>
}

// Three and a half hours behind UTC in winter, so a test assuming UTC or whole-hour offsets fails everywhere.
const ROOT_ENV = { TZ: 'America/St_Johns' }
// The web app falls back to the user's own warehouse when LOGBOOK_DB is unset; a test that lost its stub must fail on a
// missing file, never read it.
const NO_USER_WAREHOUSE = { LOGBOOK_DB: '/nonexistent/log-book-tests/warehouse.db' }

const BUILT_CLI_CHECK = './test/cli-build-check.ts'

const PROJECTS: IProjectSpec[] = [
  { name: 'root', include: ['test/**/*.test.ts'], timeout: UNIT_TIMEOUT_MS },
  { name: 'core', include: ['packages/core/src/**/*.test.ts'], timeout: UNIT_TIMEOUT_MS },
  { name: 'warehouse', include: ['packages/warehouse/src/**/*.test.ts'], timeout: WAREHOUSE_TIMEOUT_MS },
  { name: 'adapter-api', include: ['packages/adapter-api/src/**/*.test.ts'], timeout: ENGINE_TIMEOUT_MS },
  {
    name: 'adapter-claude-code',
    include: ['packages/adapter-claude-code/src/**/*.test.ts'],
    timeout: ENGINE_TIMEOUT_MS,
  },
  { name: 'adapter-opencode', include: ['packages/adapter-opencode/src/**/*.test.ts'], timeout: ENGINE_TIMEOUT_MS },
  { name: 'engine', include: ['packages/engine/src/**/*.test.ts'], timeout: ENGINE_TIMEOUT_MS },
  {
    name: 'web',
    include: ['apps/web/src/**/*.test.ts', 'apps/web/test/**/*.test.ts'],
    exclude: ['apps/web/**/*.browser.test.ts'],
    timeout: ENGINE_TIMEOUT_MS,
    isEnvStubKept: true,
    env: NO_USER_WAREHOUSE,
    isBuiltCliNeeded: true,
    setup: './apps/web/test/demo-sets.ts',
  },
  {
    name: 'cli',
    include: ['apps/cli/src/**/*.test.ts', 'apps/cli/test/composition/**/*.test.ts'],
    timeout: WAREHOUSE_TIMEOUT_MS,
  },
  { name: 'demo', include: ['packages/demo/src/**/*.test.ts'], timeout: UNIT_TIMEOUT_MS },
  { name: 'ci', include: ['packages/ci/src/**/*.test.ts'], timeout: UNIT_TIMEOUT_MS },
  {
    name: 'docs',
    include: ['apps/docs/**/*.test.ts'],
    exclude: ['apps/docs/**/*.browser.test.ts'],
    timeout: UNIT_TIMEOUT_MS,
  },
  // Every test that drives Chromium, run where it is installed.
  {
    name: 'docs-browser',
    include: ['apps/docs/**/*.browser.test.ts', 'apps/web/**/*.browser.test.ts'],
    timeout: BROWSER_TIMEOUT_MS,
  },
  {
    name: 'e2e',
    include: ['apps/cli/test/e2e/**/*.e2e.test.ts'],
    timeout: E2E_TIMEOUT_MS,
    isSerial: true,
    isBuiltCliNeeded: true,
    setup: './apps/cli/test/e2e/demo-build.ts',
  },
  {
    name: 'demo-build',
    include: ['packages/demo/test/**/*.test.ts'],
    timeout: DEMO_BUILD_TIMEOUT_MS,
    isBuiltCliNeeded: true,
    setup: './packages/demo/test/small-build.ts',
  },
]

export default defineConfig({
  test: {
    pool: 'forks',
    retry: 0,
    allowOnly: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    // Refuses any connection or DNS lookup beyond loopback in every test process, the e2e project's included, and
    // fails a test that leaves a child process running.
    setupFiles: ['./test/network-guard.ts', './test/child-process-guard.ts'],
    // Under GitHub Actions each run adds its test times to the job summary, beside the two reporters Vitest uses there
    // by default, which a configured list would otherwise replace.
    ...(process.env.GITHUB_ACTIONS === 'true'
      ? { reporters: ['default', 'github-actions', new BudgetSummaryReporter(process.env)] }
      : {}),
    env: ROOT_ENV,
    sequence: { shuffle: process.env.CI === 'true' ? { files: true, tests: true } : false },
    projects: PROJECTS.map((project) => ({
      extends: true,
      test: {
        name: project.name,
        include: project.include,
        exclude: [...EXCLUDED, ...(project.exclude ?? []), ...(project.name === 'e2e' ? [] : [E2E_TEST_FILES])],
        testTimeout: project.timeout,
        hookTimeout: project.timeout,
        fileParallelism: project.isSerial !== true,
        globalSetup: [
          ...(project.isBuiltCliNeeded === true ? [BUILT_CLI_CHECK] : []),
          ...(project.setup === undefined ? [] : [project.setup]),
        ],
        unstubEnvs: project.isEnvStubKept !== true,
        env: { ...ROOT_ENV, ...project.env },
      },
    })),
  },
})
