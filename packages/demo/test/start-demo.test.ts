import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { isProcessAlive } from '@log-book/warehouse'
import { afterEach, describe, expect, inject, it, vi } from 'vitest'
import { DEMO_ERROR_CODES } from '../src/errors.js'
import { startDemo } from '../src/start/start-demo.js'

const run = promisify(execFile)
const directories: string[] = []

// A copy of the small set the project's setup built.
const copyOfSmall = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'demo-start-'))
  directories.push(directory)
  const out = join(directory, 'small')
  await cp(inject('smallDemo').out, out, { recursive: true })
  return out
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('startDemo', () => {
  it('refuses a copy with an extra file in its demo home with DEMO_CHECK_FAILED, and no host file appears', async () => {
    // Arrange
    vi.stubEnv('TZ', 'UTC')
    const out = await copyOfSmall()
    await writeFile(join(out, 'home', 'extra.txt'), 'planted')

    // Act
    const starting = startDemo({ out })

    // Assert
    await expect(starting).rejects.toMatchObject({ code: DEMO_ERROR_CODES.DEMO_CHECK_FAILED })
    expect(existsSync(join(out, 'warehouse.db.host'))).toBe(false)
  })

  it("serves the copy at its URL with no browser, returns the build's plan and manifest, and stops", async () => {
    // Arrange
    vi.stubEnv('TZ', 'UTC')
    const out = await copyOfSmall()
    const small = inject('smallDemo')

    // Act
    const started = await startDemo({ out })
    const { status } = await fetch(`${started.url}/`)
    const { pid } = JSON.parse(await readFile(join(out, 'warehouse.db.host'), 'utf8')) as { pid: number }
    const { stdout: args } = await run('ps', ['-o', 'args=', '-p', String(pid)])
    await started.stop()

    // Assert
    expect({
      status,
      isNoOpen: args.includes('--no-open'),
      plan: started.plan,
      manifest: started.manifest,
      isAlive: isProcessAlive(pid),
    }).toStrictEqual({ status: 200, isNoOpen: true, plan: small.plan, manifest: small.manifest, isAlive: false })
  })
})
