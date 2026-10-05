import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHILD_REGISTRY_URL, createChildRegistry, KILL_AFTER_MS } from './child-registry.js'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ALLOWLIST = join(REPOSITORY_ROOT, 'packages/engine/network-call-sites.json')
const HOST_ENV = { LOGBOOK_CLI: '/opt/example/logbook.cjs', LOGBOOK_HOST_VERSION: '1.2.3' }

interface IStarted {
  command: string
  args: readonly string[]
  options: SpawnOptions
  signals: string[]
  exit: () => void
}

// A child that records the signals it gets and ends only when the test says so.
const fakeSpawn = (started: IStarted[]) => (command: string, args: readonly string[], options: SpawnOptions) => {
  const child = new EventEmitter() as EventEmitter & { kill: (signal: string) => boolean }
  const record: IStarted = { command, args, options, signals: [], exit: () => child.emit('exit', 0, null) }
  child.kill = (signal) => {
    record.signals.push(signal)
    return true
  }
  started.push(record)
  return child as unknown as ChildProcess
}

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'child-registry-'))
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(directory, { recursive: true, force: true })
})

describe('createChildRegistry', () => {
  it('starts logbook with the CLI entry and an argument array, no shell, not detached, in the host environment', () => {
    // Arrange
    const started: IStarted[] = []
    const registry = createChildRegistry({ ...HOST_ENV }, fakeSpawn(started))

    // Act
    registry.spawn(['sync', 'a b'])

    // Assert
    expect(started.map(({ command, args, options }) => ({ command, args, options }))).toStrictEqual([
      {
        command: process.execPath,
        args: ['/opt/example/logbook.cjs', 'sync', 'a b'],
        options: { env: HOST_ENV, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: false },
      },
    ])
  })

  it('starts a real child that inherits LOGBOOK_CLI and LOGBOOK_HOST_VERSION', async () => {
    // Arrange
    const entry = join(directory, 'entry.mjs')
    await writeFile(
      entry,
      'process.stdout.write(JSON.stringify([process.argv.slice(2), process.env.LOGBOOK_CLI, process.env.LOGBOOK_HOST_VERSION]))'
    )
    const registry = createChildRegistry({ ...process.env, LOGBOOK_CLI: entry, LOGBOOK_HOST_VERSION: '1.2.3' })

    // Act
    const child = registry.spawn(['sync'])
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    await new Promise((resolve) => child.once('close', resolve))

    // Assert
    expect(JSON.parse(output)).toStrictEqual([['sync'], entry, '1.2.3'])
  })

  it('sends SIGTERM to every child on stop, and resolves once they have ended', async () => {
    // Arrange
    const started: IStarted[] = []
    const registry = createChildRegistry({ ...HOST_ENV }, fakeSpawn(started))
    registry.spawn(['sync'])
    registry.spawn(['labels', 'run'])

    // Act
    const stopping = registry.stop()
    for (const child of started) {
      child.exit()
    }
    await stopping

    // Assert
    expect(started.map((child) => child.signals)).toStrictEqual([['SIGTERM'], ['SIGTERM']])
  })

  it('sends SIGKILL to a child still alive 10 seconds after SIGTERM', async () => {
    // Arrange
    vi.useFakeTimers()
    const started: IStarted[] = []
    const registry = createChildRegistry({ ...HOST_ENV }, fakeSpawn(started))
    registry.spawn(['sync'])

    // Act
    const stopping = registry.stop()
    const early = [...(started[0]?.signals ?? [])]
    vi.advanceTimersByTime(KILL_AFTER_MS)
    started[0]?.exit()
    await stopping

    // Assert
    expect({ early, all: started[0]?.signals }).toStrictEqual({ early: ['SIGTERM'], all: ['SIGTERM', 'SIGKILL'] })
  })

  it('sends SIGKILL at once on a second stop signal', () => {
    // Arrange
    vi.useFakeTimers()
    const started: IStarted[] = []
    const registry = createChildRegistry({ ...HOST_ENV }, fakeSpawn(started))
    registry.spawn(['sync'])
    void registry.stop()

    // Act
    registry.kill()

    // Assert
    expect(started[0]?.signals).toStrictEqual(['SIGTERM', 'SIGKILL'])
  })

  it('forgets a child that has ended, so a stop sends it nothing', async () => {
    // Arrange
    const started: IStarted[] = []
    const registry = createChildRegistry({ ...HOST_ENV }, fakeSpawn(started))
    registry.spawn(['sync'])
    started[0]?.exit()

    // Act
    await registry.stop()

    // Assert
    expect(started[0]?.signals).toStrictEqual([])
  })

  it('is listed in the network allowlist as a local call site, by its own path', async () => {
    // Arrange
    const sites = JSON.parse(await readFile(ALLOWLIST, 'utf8')) as { file: string; case: string }[]
    const file = relative(REPOSITORY_ROOT, fileURLToPath(CHILD_REGISTRY_URL))

    // Act
    const entries = sites.filter((site) => site.file === file).map((site) => site.case)

    // Assert
    expect(entries).toStrictEqual(['local'])
  })
})
