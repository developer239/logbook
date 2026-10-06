import { appendFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { buildDemo } from '../src/build/build-demo.js'
import type { DemoSize } from '../src/plan/types.js'

interface IBudget {
  buildMs: number
  warehouseBytes: number
}

interface IMeasured extends IBudget {
  size: DemoSize
}

const SECOND_MS = 1000
const MB = 1024 * 1024
// A build on a slow runner may pass a target; only twice a target fails.
const FAILING_FACTOR = 2
const BUDGETS: Readonly<Record<DemoSize, IBudget>> = {
  small: { buildMs: 5 * SECOND_MS, warehouseBytes: 2 * MB },
  rich: { buildMs: 60 * SECOND_MS, warehouseBytes: 60 * MB },
}

const measured: IMeasured[] = []
const directories: string[] = []

const seconds = (ms: number): string => `${(ms / SECOND_MS).toFixed(1)} s`

const megabytes = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`

const against = (value: string, target: string, isOver: boolean): string =>
  `${value} of ${target}${isOver ? ', over target' : ''}`

// Each set's build time and warehouse size against its targets, in Markdown.
const sectionOf = (rows: readonly IMeasured[]): string =>
  [
    '### Demo build budgets',
    '',
    '| Set | Build | Warehouse |',
    '| --- | --- | --- |',
    ...rows.map(({ size, buildMs, warehouseBytes }) => {
      const budget = BUDGETS[size]
      return `| ${size} | ${against(seconds(buildMs), seconds(budget.buildMs), buildMs > budget.buildMs)} | ${against(
        megabytes(warehouseBytes),
        megabytes(budget.warehouseBytes),
        warehouseBytes > budget.warehouseBytes
      )} |`
    }),
    '',
  ].join('\n')

// Printed with the run, and added to the job summary when GitHub Actions names one.
afterAll(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
  const section = sectionOf(measured)
  process.stdout.write(`\n${section}\n`)
  const summary = process.env.GITHUB_STEP_SUMMARY ?? ''
  if (summary !== '') {
    await appendFile(summary, `\n${section}\n`)
  }
})

describe('the demo build budgets', () => {
  it.each(['small', 'rich'] as const)(
    'builds the %s set within twice its time and warehouse size targets',
    async (size) => {
      // Arrange
      vi.stubEnv('TZ', 'UTC')
      const directory = await mkdtemp(join(tmpdir(), 'demo-budget-'))
      directories.push(directory)

      // Act
      const start = performance.now()
      const built = await buildDemo({ size, out: join(directory, size) })
      const buildMs = performance.now() - start
      const warehouseBytes = (await stat(built.warehouse)).size
      measured.push({ size, buildMs, warehouseBytes })

      // Assert
      expect({
        isBuildInTime: buildMs < FAILING_FACTOR * BUDGETS[size].buildMs,
        isWarehouseInSize: warehouseBytes < FAILING_FACTOR * BUDGETS[size].warehouseBytes,
      }).toStrictEqual({ isBuildInTime: true, isWarehouseInSize: true })
    }
  )
})
