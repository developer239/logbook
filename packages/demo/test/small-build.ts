import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { buildDemo, type IBuiltDemo } from '../src/build/build-demo.js'

declare module 'vitest' {
  export interface ProvidedContext {
    smallDemo: IBuiltDemo
  }
}

// The demo-build project's own setup, in the main Vitest process after the stale-build check: the small set, built once
// in UTC into a temporary directory, which is removed when the run ends. A test that changes files works on a copy.
export const setup = async (project: TestProject): Promise<() => Promise<void>> => {
  process.env.TZ = 'UTC'
  const directory = await mkdtemp(join(tmpdir(), 'demo-small-'))
  project.provide('smallDemo', await buildDemo({ size: 'small', out: join(directory, 'small') }))
  return async () => {
    await rm(directory, { recursive: true, force: true })
  }
}
