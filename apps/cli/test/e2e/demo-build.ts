import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDemo, type IBuiltDemo } from '@log-book/demo'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    e2eDemo: IBuiltDemo
  }
}

// The e2e project's own setup, in the main Vitest process after the stale-build check: the demo small set, built once
// per run in UTC into a temporary directory, which is removed when the run ends. The workers keep the configured zone;
// each test starts from its own copy of this build's home.
export const setup = async (project: TestProject): Promise<() => Promise<void>> => {
  process.env.TZ = 'UTC'
  const directory = await mkdtemp(join(tmpdir(), 'e2e-demo-'))
  project.provide('e2eDemo', await buildDemo({ size: 'small', out: join(directory, 'small') }))
  return async () => {
    await rm(directory, { recursive: true, force: true })
  }
}
