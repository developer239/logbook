import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import type { ISqliteDb } from '@log-book/core'
import { takeLabelsLock, type IHeldLock, type LabelsLockOperation } from '@log-book/warehouse'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { IChildExit, ILabellingProcess, PlanResult } from '../labelling'
import { insert, seedWarehouse, type ITestWarehouse } from '../testing/warehouse'
import type * as Labelling from './labelling'

const AT = Date.UTC(2026, 9, 5, 12)
const MINUTE = 60_000
// This process with no labelling child and nothing kept.
const NONE: ILabellingProcess = { run: null, runExit: null, planExit: null, isUpdated: false }

let warehouse: ITestWarehouse
let db: ISqliteDb
let labelling: typeof Labelling
// A process the test keeps alive, so a lock that names it is held, and the pid of one that has exited.
let holder: ChildProcess
let livePid = 0
let deadPid = 0
let held: IHeldLock | undefined

const lock = (operation: LabelsLockOperation): void => {
  held = takeLabelsLock(warehouse.path, operation, { pid: livePid })
}

interface IRunRow {
  pid: number
  startedAt?: number
  endedAt?: number | null
  outcome?: string | null
  error?: string | null
}

// A run record with two tasks, 1,240 of 2,214 records done.
const runRecord = ({ pid, startedAt = AT, endedAt = null, outcome = null, error = null }: IRunRow): void => {
  insert(db, 'label_run', {
    pid,
    started_at: startedAt,
    ended_at: endedAt,
    outcome,
    error,
    model: 'claude-haiku-4-5',
  })
  const { id } = db.prepare('SELECT MAX(id) AS id FROM label_run').get() as { id: number }
  insert(db, 'label_run_task', { run_id: id, task: 'shell', version: 1, planned: 2140, done: 1200 })
  insert(db, 'label_run_task', { run_id: id, task: 'session', version: 1, planned: 74, done: 40 })
}

const exit = (code: number | null, at = AT, lastLine: string | null = null): IChildExit => ({
  pid: deadPid,
  code,
  lastLine,
  at,
})

const PROGRESS = {
  model: 'claude-haiku-4-5',
  startedAt: AT,
  tasks: [
    { task: 'session', done: 40, planned: 74 },
    { task: 'shell', done: 1200, planned: 2140 },
  ],
  done: 1240,
  planned: 2214,
  percent: 56,
}

// A plan with this many records to label.
const planned = (records: number): PlanResult => ({
  kind: 'plan',
  plan: {
    model: 'claude-haiku-4-5',
    claudeVersion: '2.1.290',
    authMethod: null,
    apiProvider: null,
    apiKeyInEnvironment: false,
    tasks: [],
    harnesses: [],
    records,
    estimatedInputTokens: 0,
  },
})

const startHolder = (): ChildProcess =>
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })

beforeAll(async () => {
  warehouse = await seedWarehouse((seeded) => {
    db = seeded
  })
  labelling = await import('./labelling')
  holder = startHolder()
  const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(gone, 'exit')
  if (holder.pid === undefined || gone.pid === undefined) {
    throw new Error('The processes the test locks name did not start')
  }
  livePid = holder.pid
  deadPid = gone.pid
})

afterEach(() => {
  held?.release()
  held = undefined
  db.exec('DELETE FROM label_run_task; DELETE FROM label_run')
})

afterAll(async () => {
  const exited = once(holder, 'exit')
  holder.kill()
  await exited
  await warehouse.remove()
})

describe('labelling state: nothing has run', () => {
  it('never: no record and no child', () => {
    // Act
    const state = labelling.labellingState(NONE)

    // Assert
    expect(state).toStrictEqual({
      name: 'never',
      tone: 'hollow',
      at: null,
      detail: null,
      operation: null,
      progress: null,
    })
  })
})

describe("labelling state: this process's run child", () => {
  it('starting: the child lives and holds the lock, and no record carries its pid yet', () => {
    // Arrange
    lock('labels')

    // Act
    const state = labelling.labellingState({ ...NONE, run: { pid: livePid, isStopSent: false } })

    // Assert
    expect(state).toMatchObject({ name: 'starting', tone: 'slow', progress: null })
  })

  it('running-here: the newest record carries its pid, with the progress of that record', () => {
    // Arrange
    lock('labels')
    runRecord({ pid: livePid })

    // Act
    const state = labelling.labellingState({ ...NONE, run: { pid: livePid, isStopSent: false } })

    // Assert
    expect(state).toStrictEqual({
      name: 'running-here',
      tone: 'slow',
      at: AT,
      detail: null,
      operation: null,
      progress: PROGRESS,
    })
  })

  it('stopping: Stop was sent, with the progress once the record exists and without it before', () => {
    // Arrange
    lock('labels')
    const stopping = { ...NONE, run: { pid: livePid, isStopSent: true } }

    // Act
    const before = labelling.labellingState(stopping)
    runRecord({ pid: livePid })
    const after = labelling.labellingState(stopping)

    // Assert
    expect([before, after]).toMatchObject([
      { name: 'stopping', tone: 'slow', progress: null },
      { name: 'stopping', tone: 'slow', progress: PROGRESS },
    ])
  })

  it('starting: a compaction that took the lock meanwhile reads as starting until the child exits', () => {
    // Arrange
    lock('compact')

    // Act
    const state = labelling.labellingState({ ...NONE, run: { pid: livePid, isStopSent: false } })

    // Assert
    expect(state.name).toBe('starting')
  })
})

describe('labelling state: what holds the lock', () => {
  it('running-elsewhere: another pid holds it as labels, with progress when the newest record carries that pid', () => {
    // Arrange
    lock('labels')
    runRecord({ pid: livePid })

    // Act
    const state = labelling.labellingState(NONE)

    // Assert
    expect(state).toMatchObject({ name: 'running-elsewhere', tone: 'slow', progress: PROGRESS })
  })

  it('running-elsewhere: without progress while no record carries the pid of the lock (a run before its record, or a drop)', () => {
    // Arrange
    runRecord({ pid: deadPid })
    lock('labels')

    // Act
    const state = labelling.labellingState(NONE)

    // Assert
    expect(state).toMatchObject({ name: 'running-elsewhere', progress: null })
  })

  it.each(['compact', 'forget'] as const)(
    'maintenance: the lock held as %s, with and without a record that never ended',
    (operation) => {
      // Arrange
      lock(operation)

      // Act
      const without = labelling.labellingState(NONE)
      runRecord({ pid: deadPid })
      const over = labelling.labellingState(NONE)

      // Assert
      expect([without, over]).toMatchObject([
        { name: 'maintenance', tone: 'slow', operation, progress: null },
        { name: 'maintenance', tone: 'slow', operation, progress: null },
      ])
    }
  )
})

describe('labelling state: the newest record', () => {
  it.each([
    ['ok', 'finished', 'good'],
    ['stopped', 'stopped', 'hollow'],
    ['limit', 'limit', 'slow'],
    ['unreachable', 'unreachable', 'problem'],
  ] as const)('%s ends a run as %s', (outcome, name, tone) => {
    // Arrange
    runRecord({ pid: deadPid, endedAt: AT + MINUTE, outcome })

    // Act
    const state = labelling.labellingState(NONE)

    // Assert
    expect(state).toStrictEqual({ name, tone, at: AT + MINUTE, detail: null, operation: null, progress: null })
  })

  it('failed: the newest record ended failed, with its error', () => {
    // Arrange
    runRecord({ pid: deadPid, endedAt: AT + MINUTE, outcome: 'failed', error: 'the disk is full' })

    // Act
    const state = labelling.labellingState(NONE)

    // Assert
    expect(state).toMatchObject({ name: 'failed', tone: 'problem', at: AT + MINUTE, detail: 'the disk is full' })
  })

  it('interrupted: the newest record never ended and no lock is held by its pid', () => {
    // Arrange
    runRecord({ pid: deadPid })

    // Act
    const state = labelling.labellingState(NONE)

    // Assert
    expect(state).toMatchObject({ name: 'interrupted', tone: 'hollow', at: AT })
  })
})

describe('labelling state: the exits this process keeps', () => {
  it('updated: a child exited updated while running', () => {
    // Act
    const state = labelling.labellingState({ ...NONE, runExit: exit(9), isUpdated: true })

    // Assert
    expect(state).toMatchObject({ name: 'updated', tone: 'problem' })
  })

  it('needs-claude: the run child exited missing prerequisite before writing a record', () => {
    // Act
    const state = labelling.labellingState({ ...NONE, runExit: exit(7, AT, 'needs Claude Code: set CLAUDE_BIN') })

    // Assert
    expect(state).toMatchObject({ name: 'needs-claude', tone: 'problem', detail: 'needs Claude Code: set CLAUDE_BIN' })
  })

  it('failed: the run child exited failure before writing a record, with its last stderr line', () => {
    // Act
    const state = labelling.labellingState({ ...NONE, runExit: exit(1, AT, 'claude exited 2') })

    // Assert
    expect(state).toMatchObject({ name: 'failed', tone: 'problem', at: AT, detail: 'claude exited 2' })
  })

  it.each([3, 130])('exit %i of a run child that wrote no record shows the newest record', (code) => {
    // Arrange
    runRecord({ pid: livePid, startedAt: AT - 2 * MINUTE, endedAt: AT - MINUTE, outcome: 'ok' })

    // Act
    const withRecord = labelling.labellingState({ ...NONE, runExit: exit(code) })
    db.exec('DELETE FROM label_run_task; DELETE FROM label_run')
    const withNone = labelling.labellingState({ ...NONE, runExit: exit(code) })

    // Assert
    expect([withRecord.name, withNone.name]).toStrictEqual(['finished', 'never'])
  })

  it('shows the record of a run child that wrote one, not its exit', () => {
    // Arrange
    runRecord({ pid: deadPid, endedAt: AT + MINUTE, outcome: 'unreachable' })

    // Act
    const state = labelling.labellingState({ ...NONE, runExit: exit(1, AT + 2 * MINUTE, 'could not reach') })

    // Assert
    expect(state.name).toBe('unreachable')
  })

  it('needs-claude: a plan exited missing prerequisite, until a record starts after it', () => {
    // Arrange
    const kept = { ...NONE, planExit: exit(7, AT, 'needs Claude Code: set CLAUDE_BIN') }
    runRecord({ pid: livePid, startedAt: AT - 2 * MINUTE, endedAt: AT - MINUTE, outcome: 'ok' })

    // Act
    const beforeNewer = labelling.labellingState(kept).name
    runRecord({ pid: livePid, startedAt: AT + MINUTE, endedAt: AT + 2 * MINUTE, outcome: 'stopped' })
    const afterNewer = labelling.labellingState(kept).name

    // Assert
    expect([beforeNewer, afterNewer]).toStrictEqual(['needs-claude', 'stopped'])
  })

  it('a plan that succeeds after a kept missing prerequisite clears it', () => {
    // Act
    const state = labelling.labellingState({ ...NONE, planExit: exit(0, AT + MINUTE) })

    // Assert
    expect(state.name).toBe('never')
  })
})

describe('labelling facts', () => {
  it('has model labelling run only once a task did some work', () => {
    // Arrange
    insert(db, 'label_run', { pid: deadPid, started_at: AT, model: 'claude-haiku-4-5' })
    const { id } = db.prepare('SELECT MAX(id) AS id FROM label_run').get() as { id: number }
    insert(db, 'label_run_task', { run_id: id, task: 'shell', version: 1, planned: 10, done: 0 })

    // Act
    const before = labelling.hasModelLabelling()
    db.exec('UPDATE label_run_task SET done = 1')
    const after = labelling.hasModelLabelling()

    // Assert
    expect([before, after]).toStrictEqual([false, true])
  })

  it('reads the plan part from the plan or how the plan exited', () => {
    // Arrange
    const results: PlanResult[] = [
      planned(12),
      planned(0),
      { kind: 'failed', exit: exit(7) },
      { kind: 'failed', exit: exit(1) },
      { kind: 'failed', exit: exit(9) },
    ]

    // Act
    const states = results.map(labelling.planState)

    // Assert
    expect(states).toStrictEqual(['ready', 'nothing', 'needs-claude', 'plan-failed', 'updated'])
  })
})
