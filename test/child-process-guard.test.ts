import { exec, execFile, fork, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commandLineOf, recordedChildren, takeLeakedChildren } from './child-process-guard.js'

const exited = async (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.once('exit', () => {
      resolve()
    })
  })

const stopped = async (children: readonly ChildProcess[]): Promise<void> => {
  for (const child of children) {
    child.kill('SIGKILL')
  }
  await Promise.all(children.map(async (child) => exited(child)))
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('the child process guard', () => {
  let directory = ''

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'log-book-child-guard-'))
    await writeFile(join(directory, 'waiting.mjs'), 'setTimeout(() => {}, 30_000)\n')
  })

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('records a child of spawn, fork, exec and execFile with its pid and command line', async () => {
    // Arrange
    const children = [
      spawn('sleep', ['30']),
      fork(join(directory, 'waiting.mjs'), [], { execArgv: [] }),
      exec('sleep 31'),
      execFile('sleep', ['32']),
    ]

    // Act
    const recorded = recordedChildren('test').map((child) => ({ pid: child.pid, command: commandLineOf(child) }))
    await stopped(children)

    // Assert
    expect(recorded).toStrictEqual([
      { pid: children[0]?.pid, command: 'sleep 30' },
      {
        pid: children[1]?.pid,
        command: `${process.execPath.split('/').at(-1) ?? ''} ${join(directory, 'waiting.mjs')}`,
      },
      { pid: children[2]?.pid, command: 'sh -c sleep 31' },
      { pid: children[3]?.pid, command: 'sleep 32' },
    ])
  })

  it('reports a child still running and kills it, but not one that exited', async () => {
    // Arrange
    const done = spawn(process.execPath, ['-e', ''])
    await exited(done)
    const running = spawn('sleep', ['30'])

    // Act
    const leaked = takeLeakedChildren('test')
    await exited(running)

    // Assert
    expect({ leaked, isAlive: isAlive(running.pid ?? 0) }).toStrictEqual({
      leaked: [`pid ${String(running.pid)}, sleep 30`],
      isAlive: false,
    })
  })

  it('records a detached child like any other', async () => {
    // Arrange
    const detached = spawn('sleep', ['30'], { detached: true })

    // Act
    const recorded = recordedChildren('test').map((child) => child.pid)
    await stopped([detached])

    // Assert
    expect(recorded).toStrictEqual([detached.pid])
  })
})

describe('a child started in beforeAll and ended in afterAll', () => {
  let child: ChildProcess | null = null

  beforeAll(() => {
    child = spawn('sleep', ['30'])
  })

  afterAll(async () => {
    await stopped(child === null ? [] : [child])
  })

  it('is recorded for the file, not for the test', () => {
    // Act
    const scopes = { file: recordedChildren('file').map((recorded) => recorded.pid), test: recordedChildren('test') }

    // Assert
    expect(scopes).toStrictEqual({ file: [child?.pid], test: [] })
  })
})
