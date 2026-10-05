import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestWarehouse, insert, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeClaude } from '../testing/index.js'
import { runLabelling } from './label-run.js'
import { previewLabelling } from './preview.js'

const SESSION = 'test-harness:main'

const addShellCalls = (warehouse: ITestWarehouse, count: number): void => {
  insert(warehouse.db, 'session', {
    id: SESSION,
    harness: 'test-harness',
    source_id: 'main',
    origin: 'scripted',
    is_scripted: 1,
  })
  for (let index = 0; index < count; index += 1) {
    const id = `c${String(index).padStart(2, '0')}`
    insert(warehouse.db, 'tool_call', {
      id,
      session_id: SESSION,
      message_id: `${SESSION}/m1`,
      name: 'Bash',
      bare_name: 'Bash',
      family: 'shell',
      input_json: JSON.stringify({ command: `ls ${id}` }),
      status: 'ok',
    })
  }
}

describe('previewLabelling', () => {
  let home = ''
  let warehouse: ITestWarehouse | null = null

  const opened = (): ITestWarehouse => {
    if (warehouse === null) {
      throw new Error('The warehouse is not open.')
    }
    return warehouse
  }

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'log-book-preview-')))
    vi.stubEnv('PATH', join(home, 'nothing'))
    vi.stubEnv('CLAUDE_BIN', '')
    warehouse = await createTestWarehouse()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await warehouse?.remove()
    warehouse = null
    await rm(home, { recursive: true, force: true })
  })

  it('previews the next batch exactly as a labels.run started right after sends it', async () => {
    // Arrange
    addShellCalls(opened(), 3)
    const preview = await previewLabelling({ warehousePath: opened().path, task: 'shell' })
    const bin = join(home, 'bin')
    await mkdir(bin)
    const fake = await installFakeClaude(bin, {
      answers: [{ systemPrompt: 'You label shell commands', answer: '0 0' }],
    })
    vi.stubEnv('PATH', bin)

    // Act
    await runLabelling({
      warehousePath: opened().path,
      scope: { kind: 'run', task: 'shell' },
      signal: new AbortController().signal,
    })

    // Assert
    const [sent] = (await fake.readRecords()).filter(({ argv }) => argv.includes('-p'))
    const argv = sent?.argv ?? []
    expect({ system: preview.system, batches: preview.batches }).toStrictEqual({
      system: argv[argv.indexOf('--system-prompt') + 1],
      batches: [{ prompt: sent?.stdin, records: 3 }],
    })
  })

  it('runs no claude, takes no lock and writes no run record, with no claude on the PATH', async () => {
    // Arrange
    addShellCalls(opened(), 3)

    // Act
    const preview = await previewLabelling({ warehousePath: opened().path, task: 'shell' })

    // Assert
    expect({
      records: preview.batches.map(({ records }) => records),
      lockFiles: [existsSync(`${opened().path}.labels.lock`), existsSync(`${opened().path}.lock`)],
      runs: (opened().db.prepare('SELECT count(*) AS count FROM label_run').get() as { count: number }).count,
      hasNote: preview.note.includes('framing'),
    }).toStrictEqual({ records: [3], lockFiles: [false, false], runs: 0, hasNote: true })
  })

  it('holds 25 records in each of two shell batches when 60 are pending', async () => {
    // Arrange
    addShellCalls(opened(), 60)

    // Act
    const preview = await previewLabelling({ warehousePath: opened().path, task: 'shell', batches: 2 })

    // Assert
    expect(preview.batches.map(({ records }) => records)).toStrictEqual([25, 25])
  })

  it('returns an empty preview for a task with nothing pending', async () => {
    // Act
    const preview = await previewLabelling({ warehousePath: opened().path, task: 'reply', batches: 3 })

    // Assert
    expect(preview.batches).toStrictEqual([])
  })
})
