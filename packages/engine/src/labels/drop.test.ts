import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ERROR_CODES } from '@log-book/core'
import { readLabelsLock, readSyncLock, RULES_LABELLER, WarehouseLockHeldError } from '@log-book/warehouse'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeClaude, typeScriptChildArgs, type IFakeClaude } from '../testing/index.js'
import { dropLabels } from './drop.js'
import { runLabelling } from './label-run.js'

const CHILD_TIMEOUT_MS = 20_000
const MODEL = 'claude-haiku-4-5'
const OTHER_MODEL = 'claude-sonnet-5-5'
const SESSION = 'test-harness:main'

const label = (
  recordType: string,
  recordId: string,
  labeller: string,
  name: string
): Record<string, string | number> => ({
  record_type: recordType,
  record_id: recordId,
  labeller,
  version: 1,
  name,
  value: 'x',
  labelled_at: 1,
})

// Runs a drop of the model's prompt labels, and prints how many records it dropped.
const DROPPING_CHILD = `const [dropUrl, warehousePath, labeller] = process.argv.slice(2)
const { dropLabels } = await import(dropUrl)
process.stdout.write(String(await dropLabels({ warehousePath, task: 'prompt', labeller })))
`

// Holds the warehouse's locks as a compaction or a forget does.
const HOLDING_CHILD = `const [operation, moduleUrl, warehousePath, sessionId] = process.argv.slice(2)
const module = await import(moduleUrl)
const signal = new AbortController().signal
const result =
  operation === 'compact'
    ? await module.runCompact({ warehousePath, signal, onProgress: () => {} })
    : await module.runForget({ warehousePath, target: { sessions: [sessionId] }, signal, onProgress: () => {} })
process.stdout.write(result.outcome)
`

interface ILabelRow {
  record_type: string
  record_id: string
  labeller: string
  name: string
}

// The labels the prompt task writes for a labeller: its prompts' acts and their reactions.
const promptLabelsOf = (rows: readonly ILabelRow[], labeller: string): ILabelRow[] =>
  rows.filter((row) => row.labeller === labeller && (row.name === 'act' || row.record_type === 'reaction'))

describe('dropLabels', () => {
  let home = ''
  let warehouse: ITestWarehouse | null = null

  const opened = (): ITestWarehouse => {
    if (warehouse === null) {
      throw new Error('The warehouse is not open.')
    }
    return warehouse
  }

  const drop = async (task: string, labeller: string): Promise<number> =>
    dropLabels({ warehousePath: opened().path, task, labeller })

  const labels = (): ILabelRow[] =>
    (
      opened()
        .db.prepare(
          'SELECT record_type, record_id, labeller, name FROM label ORDER BY record_type, record_id, labeller, name'
        )
        .all() as ILabelRow[]
    ).map((row) => ({ ...row }))

  const runCount = (): number =>
    (opened().db.prepare('SELECT count(*) AS count FROM label_run').get() as { count: number }).count

  const child = async (script: string, args: string[]): Promise<{ pid: number; closed: Promise<string> }> => {
    const file = join(home, `child-${String(Date.now())}.mjs`)
    await writeFile(file, script)
    const running = spawn(process.execPath, [...(await typeScriptChildArgs(home)), file, ...args], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    running.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    return { pid: running.pid ?? 0, closed: new Promise((resolve) => running.on('close', () => resolve(stdout))) }
  }

  const installOnPath = async (): Promise<IFakeClaude> => {
    const bin = await mkdtemp(join(home, 'bin-'))
    vi.stubEnv('PATH', bin)
    return installFakeClaude(bin, { answers: [{ systemPrompt: 'You label shell commands', answer: '0 0' }] })
  }

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'log-book-drop-')))
    vi.stubEnv('HOME', home)
    vi.stubEnv('PATH', join(home, 'nothing'))
    vi.stubEnv('CLAUDE_BIN', '')
    warehouse = await createTestWarehouse()
    for (const row of [
      label('message', 'p1', MODEL, 'act'),
      label('reaction', 'p1#1', MODEL, 'reaction'),
      label('reaction', 'p1#1', MODEL, 'target'),
      label('message', 'p2', MODEL, 'act'),
      label('message', 'p1', OTHER_MODEL, 'act'),
      label('message', 'r1', MODEL, 'reply'),
      label('tool_call', 'c1', RULES_LABELLER, 'purpose'),
      label('tool_call', 'c1', MODEL, 'purpose'),
    ]) {
      insert(warehouse.db, 'label', row)
    }
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await warehouse?.remove()
    warehouse = null
    await rm(home, { recursive: true, force: true })
  })

  it("deletes only the model's labels of the task, keeping another model's, other tasks' and the rules', with no run record", async () => {
    // Act
    const dropped = await drop('prompt', MODEL)

    // Assert
    expect({
      dropped,
      labels: labels(),
      runs: runCount(),
      lockFile: existsSync(`${opened().path}.labels.lock`),
    }).toStrictEqual({
      dropped: 2,
      labels: [
        { record_type: 'message', record_id: 'p1', labeller: OTHER_MODEL, name: 'act' },
        { record_type: 'message', record_id: 'r1', labeller: MODEL, name: 'reply' },
        { record_type: 'tool_call', record_id: 'c1', labeller: MODEL, name: 'purpose' },
        { record_type: 'tool_call', record_id: 'c1', labeller: RULES_LABELLER, name: 'purpose' },
      ],
      runs: 0,
      lockFile: false,
    })
  })

  it('deletes nothing and returns 0 for a model that labelled none', async () => {
    // Arrange
    const before = labels()

    // Act
    const dropped = await drop('prompt', 'claude-opus-5-5')

    // Assert
    expect({ dropped, labels: labels() }).toStrictEqual({ dropped: 0, labels: before })
  })

  it.each([
    ['the rules labeller', 'shell', RULES_LABELLER],
    ['an unknown task', 'goals', MODEL],
  ])('refuses %s before the lock', async (_case, task, labeller) => {
    // Act
    const dropping = drop(task, labeller)

    // Assert
    await expect(dropping).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR })
    expect(existsSync(`${opened().path}.labels.lock`)).toBe(false)
  })

  it(
    'holds the labelling lock while its delete waits, so a labelling run started then is refused with no run record',
    async () => {
      // Arrange
      await installOnPath()
      opened().db.exec('PRAGMA journal_mode = WAL')
      // The delete waits for the write lock until the test ends this transaction.
      opened().db.exec('BEGIN IMMEDIATE')
      const dropping = await child(DROPPING_CHILD, [new URL('drop.ts', import.meta.url).href, opened().path, MODEL])
      await vi.waitFor(
        () => {
          const { pid, operation } = readLabelsLock(opened().path)
          expect({ pid, operation }).toStrictEqual({ pid: dropping.pid, operation: 'labels' })
        },
        { timeout: CHILD_TIMEOUT_MS }
      )

      // Act
      const labelling = runLabelling({
        warehousePath: opened().path,
        scope: { kind: 'update' },
        signal: new AbortController().signal,
      })
      await expect(labelling).rejects.toMatchObject({ operation: 'labels', pid: dropping.pid })
      opened().db.exec('COMMIT')
      const dropped = await dropping.closed

      // Assert
      expect({
        dropped,
        runs: runCount(),
        prompts: promptLabelsOf(labels(), MODEL),
        lockFile: existsSync(`${opened().path}.labels.lock`),
      }).toStrictEqual({ dropped: '2', runs: 0, prompts: [], lockFile: false })
    },
    CHILD_TIMEOUT_MS
  )

  it('is refused while a labelling run holds the lock, deleting nothing', async () => {
    // Arrange
    insert(opened().db, 'session', {
      id: SESSION,
      harness: 'test-harness',
      source_id: 'main',
      origin: 'scripted',
      is_scripted: 1,
    })
    insert(opened().db, 'tool_call', {
      id: 'c9',
      session_id: SESSION,
      message_id: 'm',
      name: 'Bash',
      bare_name: 'Bash',
      family: 'shell',
      input_json: '{"command":"ls c9"}',
      status: 'ok',
    })
    const release = join(home, 'release')
    const bin = await mkdtemp(join(home, 'bin-'))
    vi.stubEnv('PATH', bin)
    const fake = await installFakeClaude(bin, {
      answers: [{ systemPrompt: 'You label shell commands', answer: '0 0' }],
      rules: [{ marker: 'ls c9', kind: 'hold', file: release }],
    })
    const running = runLabelling({
      warehousePath: opened().path,
      scope: { kind: 'update' },
      signal: new AbortController().signal,
    })
    await vi.waitFor(
      async () => expect((await fake.readRecords()).some(({ argv }) => argv.includes('-p'))).toBe(true),
      { timeout: CHILD_TIMEOUT_MS }
    )
    const before = labels()

    // Act
    const dropping = drop('prompt', MODEL)

    // Assert
    await expect(dropping).rejects.toBeInstanceOf(WarehouseLockHeldError)
    await expect(dropping).rejects.toMatchObject({ operation: 'labels', pid: process.pid })
    expect(labels()).toStrictEqual(before)
    await writeFile(release, '')
    await running
  })

  it.each([
    ['compact', '../rewrite/compact.ts'],
    ['forget', '../rewrite/forget.ts'],
  ])(
    'is refused while %s holds both locks, deleting nothing',
    async (operation, module) => {
      // Arrange
      insert(opened().db, 'session', {
        id: SESSION,
        harness: 'test-harness',
        source_id: 'main',
        origin: 'scripted',
        is_scripted: 1,
      })
      opened().db.exec('PRAGMA journal_mode = WAL')
      opened().db.exec('BEGIN IMMEDIATE')
      const holder = await child(HOLDING_CHILD, [
        operation,
        new URL(module, import.meta.url).href,
        opened().path,
        SESSION,
      ])
      await vi.waitFor(
        () => {
          expect([readSyncLock(opened().path).pid, readLabelsLock(opened().path).pid]).toStrictEqual([
            holder.pid,
            holder.pid,
          ])
        },
        { timeout: CHILD_TIMEOUT_MS }
      )

      // Act
      const dropping = drop('prompt', MODEL)
      await expect(dropping).rejects.toMatchObject({ operation, pid: holder.pid })
      opened().db.exec('COMMIT')
      const outcome = await holder.closed

      // Assert
      expect({ outcome, promptLabels: promptLabelsOf(labels(), MODEL) }).toStrictEqual({
        outcome: 'ok',
        promptLabels: [
          { record_type: 'message', record_id: 'p1', labeller: MODEL, name: 'act' },
          { record_type: 'message', record_id: 'p2', labeller: MODEL, name: 'act' },
          { record_type: 'reaction', record_id: 'p1#1', labeller: MODEL, name: 'reaction' },
          { record_type: 'reaction', record_id: 'p1#1', labeller: MODEL, name: 'target' },
        ],
      })
    },
    CHILD_TIMEOUT_MS
  )
})
