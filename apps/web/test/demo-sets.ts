import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDemo, type IBuiltDemo } from '@log-book/demo'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    // The demo small set and its variant without model labels, built once per run: out directory, warehouse and plan.
    demoSmall: IBuiltDemo
    demoSmallNoLabels: IBuiltDemo
  }
}

// The web project's own setup, in the main Vitest process after the stale-build check. The demo is built in UTC, which
// buildDemo requires; the workers keep the configuration's zone, so the tests still run where UTC assumptions show.
// Both build directories are removed when the run ends; a test works on its own copy of a warehouse.
export const setup = async (project: TestProject): Promise<() => Promise<void>> => {
  process.env.TZ = 'UTC'
  const directory = await mkdtemp(join(tmpdir(), 'web-demo-'))
  const [small, noLabels] = await Promise.all([
    buildDemo({ size: 'small', out: join(directory, 'small') }),
    buildDemo({ size: 'small', labels: 'none', out: join(directory, 'small-no-labels') }),
  ])
  project.provide('demoSmall', small)
  project.provide('demoSmallNoLabels', noLabels)
  return async () => {
    await rm(directory, { recursive: true, force: true })
  }
}
