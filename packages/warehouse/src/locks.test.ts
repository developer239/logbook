import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runSubprocess } from '@log-book/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readLabelsLock, readSyncLock, takeLabelsLock, takeSyncLock, type IHeldLock } from './locks.js'

const CHILD_TIMEOUT_MS = 10_000
const STARTED_AT = 1_791_100_800_000

// The permission bits, the low nine bits of the mode.
const modeOf = (path: string): number => statSync(path).mode % 0o1000

// A pid no process has: a child that has already exited.
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid

const writeLockFile = (path: string, pid: number, operation: string): void =>
  writeFileSync(path, JSON.stringify({ pid, startedAt: STARTED_AT, operation }))

// Lets a child process import the TypeScript sources: Node strips the types, and this maps an import of `./x.js` to
// `./x.ts` when no `./x.js` exists.
const RESOLVE_TYPESCRIPT_HOOK = `export const resolve = async (specifier, context, nextResolve) => {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context)
    }
    throw error
  }
}
`

// Waits for the go file, tries the sync lock, writes what happened, and keeps a held lock until the done file appears.
const RACING_CHILD = `import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
const [locksUrl, warehousePath, resultFile, goFile, doneFile] = process.argv.slice(2)
const { takeSyncLock } = await import(locksUrl)
while (!existsSync(goFile)) {
  await delay(5)
}
try {
  takeSyncLock(warehousePath, 'sync')
  writeFileSync(resultFile, 'held')
  while (!existsSync(doneFile)) {
    await delay(5)
  }
} catch (error) {
  writeFileSync(resultFile, error.code)
}
`

// Takes the sync lock, says so with its pid, and stays alive until a signal ends it.
const HOLDING_CHILD = `import { writeFileSync } from 'node:fs'
const [locksUrl, warehousePath, readyFile] = process.argv.slice(2)
const { takeSyncLock } = await import(locksUrl)
takeSyncLock(warehousePath, 'sync')
writeFileSync(readyFile, String(process.pid))
setInterval(() => {}, 1000)
`

describe('locks', () => {
  let directory = ''
  let warehousePath = ''
  let held: IHeldLock[] = []

  const writeChildFiles = async (child: string): Promise<{ register: string; script: string }> => {
    const hook = join(directory, 'hook.mjs')
    const register = join(directory, 'register.mjs')
    const script = join(directory, 'child.mjs')
    await writeFile(hook, RESOLVE_TYPESCRIPT_HOOK)
    await writeFile(
      register,
      `import { register } from 'node:module'\nregister(${JSON.stringify(pathToFileURL(hook).href)})\n`
    )
    await writeFile(script, child)
    return { register, script }
  }

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-locks-')))
    warehousePath = join(directory, 'warehouse.db')
    held = []
  })

  afterEach(async () => {
    for (const lock of held) {
      lock.release()
    }
    await rm(directory, { recursive: true, force: true })
  })

  it.each(['sync', 'compact', 'forget'] as const)('reads back a sync lock taken as %s', (operation) => {
    // Arrange
    held.push(takeSyncLock(warehousePath, operation))

    // Act
    const state = readSyncLock(warehousePath)

    // Assert
    expect(state).toStrictEqual({
      isHeld: true,
      isAlive: true,
      pid: process.pid,
      startedAt: expect.any(Number) as number,
      operation,
    })
  })

  it.each(['labels', 'compact', 'forget'] as const)('reads back a labelling lock taken as %s', (operation) => {
    // Arrange
    held.push(takeLabelsLock(warehousePath, operation))

    // Act
    const state = readLabelsLock(warehousePath)

    // Assert
    expect(state).toStrictEqual({
      isHeld: true,
      isAlive: true,
      pid: process.pid,
      startedAt: expect.any(Number) as number,
      operation,
    })
  })

  it('refuses a second take while a live process holds the lock and leaves the file unchanged', async () => {
    // Arrange
    const lockPath = `${warehousePath}.lock`
    writeLockFile(lockPath, process.ppid, 'compact')
    const before = await readFile(lockPath, 'utf8')

    // Act
    const taking = (): IHeldLock => takeSyncLock(warehousePath, 'sync')

    // Assert
    expect(taking).toThrow(
      expect.objectContaining({
        code: 'WAREHOUSE_LOCK_HELD',
        pid: process.ppid,
        startedAt: STARTED_AT,
        operation: 'compact',
        path: lockPath,
      })
    )
    expect(await readFile(lockPath, 'utf8')).toBe(before)
  })

  it('takes over a lock whose holder is dead', () => {
    // Arrange
    writeLockFile(`${warehousePath}.lock`, deadPid(), 'sync')

    // Act
    held.push(takeSyncLock(warehousePath, 'forget'))

    // Assert
    expect(readSyncLock(warehousePath)).toStrictEqual({
      isHeld: true,
      isAlive: true,
      pid: process.pid,
      startedAt: expect.any(Number) as number,
      operation: 'forget',
    })
  })

  it('counts a lock naming pid 1, which runs under another user, as held', () => {
    // Arrange
    writeLockFile(`${warehousePath}.labels.lock`, 1, 'labels')

    // Act
    const state = readLabelsLock(warehousePath)
    const taking = (): IHeldLock => takeLabelsLock(warehousePath, 'labels')

    // Assert
    expect(state).toStrictEqual({ isHeld: true, isAlive: true, pid: 1, startedAt: STARTED_AT, operation: 'labels' })
    expect(taking).toThrow(expect.objectContaining({ code: 'WAREHOUSE_LOCK_HELD', pid: 1 }))
  })

  it('reads no lock, and a dead holder without deleting its file', () => {
    // Arrange
    const none = readSyncLock(warehousePath)
    const pid = deadPid()
    writeLockFile(`${warehousePath}.lock`, pid, 'sync')

    // Act
    const dead = readSyncLock(warehousePath)

    // Assert
    expect({ none, dead, isFileKept: existsSync(`${warehousePath}.lock`) }).toStrictEqual({
      none: { isHeld: false, isAlive: false, pid: null, startedAt: null, operation: null },
      dead: { isHeld: false, isAlive: false, pid, startedAt: STARTED_AT, operation: 'sync' },
      isFileKept: true,
    })
  })

  it('names another live process when options.pid is set', () => {
    // Arrange
    const pid = process.ppid

    // Act
    held.push(takeSyncLock(warehousePath, 'sync', { pid }))

    // Assert
    expect(readSyncLock(warehousePath)).toStrictEqual({
      isHeld: true,
      isAlive: true,
      pid,
      startedAt: expect.any(Number) as number,
      operation: 'sync',
    })
  })

  it('refuses a lock file Log Book did not write and leaves it in place', () => {
    // Arrange
    const lockPath = `${warehousePath}.lock`
    writeFileSync(lockPath, 'not json')

    // Act
    const taking = (): IHeldLock => takeSyncLock(warehousePath, 'sync')

    // Assert
    expect(taking).toThrow(
      expect.objectContaining({
        code: 'WAREHOUSE_LOCK_UNREADABLE',
        message: `The lock file ${lockPath} was not written by Log Book.`,
      })
    )
    expect(readFileSync(lockPath, 'utf8')).toBe('not json')
  })

  it('creates both lock files with mode 0600 and deletes them on release, twice safely', () => {
    // Arrange
    const syncLock = takeSyncLock(warehousePath, 'sync')
    const labelsLock = takeLabelsLock(warehousePath, 'labels')
    const modes = [modeOf(`${warehousePath}.lock`), modeOf(`${warehousePath}.labels.lock`)]

    // Act
    syncLock.release()
    syncLock.release()
    labelsLock.release()

    // Assert
    expect({ modes, sync: readSyncLock(warehousePath).pid, labels: readLabelsLock(warehousePath).pid }).toStrictEqual({
      modes: [0o600, 0o600],
      sync: null,
      labels: null,
    })
  })

  it('lets exactly one of two processes take the same free lock at once', async () => {
    // Arrange
    const { register, script } = await writeChildFiles(RACING_CHILD)
    const locksUrl = new URL('./locks.ts', import.meta.url).href
    const goFile = join(directory, 'go')
    const doneFile = join(directory, 'done')
    const resultFiles = [join(directory, 'result-1'), join(directory, 'result-2')]
    const children = resultFiles.map((resultFile) =>
      runSubprocess({
        command: process.execPath,
        args: ['--import', register, script, locksUrl, warehousePath, resultFile, goFile, doneFile],
        timeoutMs: CHILD_TIMEOUT_MS,
        label: 'node',
      })
    )

    // Act
    await writeFile(goFile, '')
    await vi.waitFor(() => expect(resultFiles.map((file) => existsSync(file))).toStrictEqual([true, true]), {
      timeout: CHILD_TIMEOUT_MS,
    })
    const results = resultFiles.map((file) => readFileSync(file, 'utf8'))
    await writeFile(doneFile, '')
    await Promise.all(children)

    // Assert
    expect(results.toSorted()).toStrictEqual(['WAREHOUSE_LOCK_HELD', 'held'])
  })

  it.each(['SIGTERM', 'SIGINT'] as const)('leaves no lock file when the holder is sent %s', async (signal) => {
    // Arrange
    const { register, script } = await writeChildFiles(HOLDING_CHILD)
    const locksUrl = new URL('./locks.ts', import.meta.url).href
    const readyFile = join(directory, 'ready')
    const child = runSubprocess({
      command: process.execPath,
      args: ['--import', register, script, locksUrl, warehousePath, readyFile],
      timeoutMs: CHILD_TIMEOUT_MS,
      label: 'node',
    })
    // A pid of 0 would signal the whole process group, so only a written positive pid counts as ready.
    const pid = await vi.waitFor(
      () => {
        const value = Number(readFileSync(readyFile, 'utf8'))
        if (!(value > 0)) {
          throw new Error('The child has not written its pid yet')
        }
        return value
      },
      { timeout: CHILD_TIMEOUT_MS }
    )
    const wasHeld = readSyncLock(warehousePath).isHeld

    // Act
    process.kill(pid, signal)
    const result = await child

    // Assert
    expect({ wasHeld, exitCode: result.exitCode, isFileLeft: existsSync(`${warehousePath}.lock`) }).toStrictEqual({
      wasHeld: true,
      exitCode: -1,
      isFileLeft: false,
    })
  })
})
