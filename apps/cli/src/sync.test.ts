import { execFile, spawn } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ISyncAdapterResult, ISyncResult } from '@log-book/engine'
import { typeScriptChildArgs } from '@log-book/engine/testing'
import { WAREHOUSE_ERROR_CODES, WarehouseLockHeldError, WarehouseVersionError } from '@log-book/warehouse'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from './run-cli.js'
import { createSyncRunner, syncSummary, type StartSync, type SyncMessage } from './sync.js'

interface IRun {
  code: number
  stdout: string
  stderr: string
}

interface IChildRun extends IRun {
  messages: unknown[]
}

const HOME = '/home/example'
const SYNC_MODULE = pathToFileURL(new URL('sync.ts', import.meta.url).pathname).href
const VERSION_NOTICE = 'Recorded by Claude Code 2.2.0; this Log Book is tested with 2.1.'
const FORMAT_NOTICE =
  'The OpenCode database is at migration 20261001120000_example_change; this Log Book is tested up to 20260923013825_example_time.'
const READ_PROBLEM = 'OpenCode: cannot read ~/.local/share/opencode/opencode.db: unable to open database file'
const DERIVE_PROBLEM = 'Claude Code: example derivation failed'

const adapter = (fields: Partial<ISyncAdapterResult> & Pick<ISyncAdapterResult, 'name'>): ISyncAdapterResult => ({
  isFound: true,
  location: '~/example',
  imported: 0,
  unchanged: 0,
  gone: 0,
  skipped: 0,
  isReread: false,
  unknownByType: {},
  notice: null,
  ...fields,
})

const NOT_FOUND = adapter({ name: 'OpenCode', isFound: false, location: null })

const syncResult = (fields: Partial<ISyncResult> = {}): ISyncResult => ({
  outcome: 'ok',
  adapters: [adapter({ name: 'Claude Code', imported: 412 }), NOT_FOUND],
  problems: [],
  sessions: 1010,
  durationMs: 31_000,
  ...fields,
})

const run = async (startSync: StartSync, send?: (message: SyncMessage) => void): Promise<IRun> => {
  let stdout = ''
  let stderr = ''
  const runner = createSyncRunner(startSync, () => send)
  const code = await runCli(
    {
      argv: ['sync'],
      env: {},
      home: HOME,
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      isStderrTty: false,
      signal: new AbortController().signal,
    },
    { sync: runner }
  )
  return { code, stdout, stderr }
}

const returning =
  (result: ISyncResult): StartSync =>
  async () =>
    Promise.resolve(result)

const lines = (text: string): string[] => text.split('\n').filter((line) => line.length > 0)

const rereadingTwentyUnits: StartSync = async ({ onProgress }) => {
  for (let done = 1; done <= 20; done += 1) {
    onProgress({ adapter: 'opencode', done, total: 20, reread: true })
  }
  onProgress({ phase: 'derivations' })
  return Promise.resolve(syncResult())
}

// Runs the sync runner in a child of its own over a stand-in sync, through the production channel lookup.
const CHILD_SCRIPT = `
import { createSyncRunner, ipcChannel } from '${SYNC_MODULE}'
const result = {
  outcome: 'ok',
  adapters: [{ name: 'Claude Code', isFound: true, location: '~/example', imported: 2, unchanged: 1, gone: 0,
    skipped: 0, isReread: false, unknownByType: {}, notice: null }],
  problems: [],
  sessions: 3,
  durationMs: 1200,
}
const startSync = async ({ onProgress }) => {
  for (const done of [1, 2, 3]) {
    onProgress({ adapter: 'claude-code', done, total: 3, reread: false })
  }
  onProgress({ phase: 'derivations' })
  return result
}
const io = {
  argv: ['sync'],
  env: {},
  home: '${HOME}',
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  isStderrTty: false,
  signal: new AbortController().signal,
}
process.exitCode = await createSyncRunner(startSync, ipcChannel)({
  command: 'sync', values: {}, positionals: [], io, version: '0.0.0',
})
`

const runChild = async (hasChannel: boolean): Promise<IChildRun> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cli-sync-')))
  try {
    const args = [...(await typeScriptChildArgs(directory)), '--input-type=module', '-e', CHILD_SCRIPT]
    if (!hasChannel) {
      return await new Promise((resolve) => {
        execFile(process.execPath, args, (error, stdout, stderr) => {
          resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr, messages: [] })
        })
      })
    }
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      if (child.stdout === null || child.stderr === null) {
        throw new Error('The child was spawned with piped stdout and stderr')
      }
      const messages: unknown[] = []
      let stdout = ''
      let stderr = ''
      child.on('message', (message) => messages.push(message))
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('close', (code) => {
        resolve({ code: code ?? -1, stdout, stderr, messages })
      })
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('logbook sync', () => {
  describe('outcomes', () => {
    it('prints the summary on stdout and exits 0 when the sync ends ok', async () => {
      // Act
      const result = await run(returning(syncResult()))

      // Assert
      expect(result).toStrictEqual({
        code: 0,
        stdout: `${syncSummary(syncResult())}\n`,
        stderr: '',
      })
    })

    it('prints every problem line, then the one-problem line last, and exits 10 when the sync is partial', async () => {
      // Arrange
      const partial = syncResult({ outcome: 'partial', problems: [READ_PROBLEM] })

      // Act
      const result = await run(returning(partial))

      // Assert
      expect(result.code).toBe(10)
      expect(result.stdout).toBe(`${syncSummary(partial)}\n`)
      expect(lines(result.stderr)).toStrictEqual([READ_PROBLEM, `Sync finished with 1 problem: ${READ_PROBLEM}`])
    })

    it('counts two problems in the plural and names the first', async () => {
      // Act
      const result = await run(returning(syncResult({ outcome: 'partial', problems: [READ_PROBLEM, DERIVE_PROBLEM] })))

      // Assert
      expect(result.code).toBe(10)
      expect(lines(result.stderr)).toStrictEqual([
        READ_PROBLEM,
        DERIVE_PROBLEM,
        `Sync finished with 2 problems: ${READ_PROBLEM}`,
      ])
    })

    it('exits 130 and prints no summary when the sync is stopped', async () => {
      // Act
      const result = await run(returning(syncResult({ outcome: 'stopped' })))

      // Assert
      expect(result).toStrictEqual({ code: 130, stdout: '', stderr: '' })
    })

    it('exits 3 with the holder line when another sync holds the lock', async () => {
      // Arrange
      const path = '/tmp/example/warehouse.db.lock'
      const held = new WarehouseLockHeldError('held', { pid: 4242, startedAt: 1, operation: 'sync', path })

      // Act
      const result = await run(vi.fn<StartSync>().mockRejectedValue(held))

      // Assert
      expect(result).toStrictEqual({
        code: 3,
        stdout: '',
        stderr: `A sync is already running on this warehouse (pid 4242, lock file ${path}). If none is running, delete that file.\n`,
      })
    })

    it('exits 1 with the error as the last stderr line when the sync fails', async () => {
      // Act
      const result = await run(vi.fn<StartSync>().mockRejectedValue(new Error('example disk failure')))

      // Assert
      expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'example disk failure\n' })
    })

    it('exits 6 with the update line when the warehouse is newer than this Log Book', async () => {
      // Arrange
      const newer = new WarehouseVersionError('newer', WAREHOUSE_ERROR_CODES.WAREHOUSE_SCHEMA_NEWER, 99, 2)

      // Act
      const result = await run(vi.fn<StartSync>().mockRejectedValue(newer))

      // Assert
      expect(result.code).toBe(6)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/^The warehouse is at schema 99;.*\n$/u)
    })
  })

  describe('the summary', () => {
    it('lists each adapter with its counts, leaving out zeros except imported and unchanged', () => {
      // Arrange
      const result = syncResult({
        adapters: [
          adapter({
            name: 'Claude Code',
            imported: 1412,
            gone: 1,
            skipped: 2,
            unknownByType: { 'system:example_subtype': 1, 'attachment:example_kind': 2, 'attachment:example_aside': 1 },
          }),
          adapter({ name: 'Example Harness', unchanged: 598 }),
          NOT_FOUND,
        ],
        sessions: 1010,
        durationMs: 31_000,
      })

      // Act
      const summary = syncSummary(result)

      // Assert
      expect(summary).toBe(
        [
          '# Sync',
          '',
          '**Claude Code:** 1,412 imported, 0 unchanged, 1 gone while reading, 2 skipped, 4 records not recognised ' +
            '(attachment:example_kind 2, attachment:example_aside 1, system:example_subtype 1)',
          '**Example Harness:** 0 imported, 598 unchanged',
          '**OpenCode:** not on this machine',
          '**Sessions in the warehouse:** 1,010',
          '**Took:** 31 s',
        ].join('\n')
      )
    })

    it('counts a single unknown record in the singular', () => {
      // Act
      const summary = syncSummary(
        syncResult({ adapters: [adapter({ name: 'Claude Code', unknownByType: { 'system:example_subtype': 1 } })] })
      )

      // Assert
      expect(lines(summary)[1]).toBe(
        '**Claude Code:** 0 imported, 0 unchanged, 1 record not recognised (system:example_subtype 1)'
      )
    })
  })

  describe('drift notices', () => {
    it.each([
      [
        'a version notice',
        adapter({ name: 'Claude Code', imported: 412, notice: VERSION_NOTICE }),
        '412 imported, 0 unchanged',
      ],
      [
        'a format notice on a sync that imported nothing',
        adapter({ name: 'OpenCode', unchanged: 598, notice: FORMAT_NOTICE }),
        '0 imported, 598 unchanged',
      ],
      [
        'a notice holding both sentences',
        adapter({ name: 'OpenCode', imported: 3, notice: `${VERSION_NOTICE} ${FORMAT_NOTICE}` }),
        '3 imported, 0 unchanged',
      ],
    ])('prints %s after the counts as given, exits 0 and writes no problem line', async (_case, noticed, counts) => {
      // Act
      const result = await run(returning(syncResult({ adapters: [noticed] })))

      // Assert
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(lines(result.stdout)[1]).toBe(`**${noticed.name}:** ${counts}. ${String(noticed.notice)}`)
    })

    it('leaves a partial sync with a notice at exit 10 and its problem line last', async () => {
      // Arrange
      const noticed = adapter({ name: 'Claude Code', imported: 1, notice: VERSION_NOTICE })

      // Act
      const result = await run(
        returning(syncResult({ outcome: 'partial', adapters: [noticed, NOT_FOUND], problems: [READ_PROBLEM] }))
      )

      // Assert
      expect(result.code).toBe(10)
      expect(lines(result.stdout)[1]).toBe(`**Claude Code:** 1 imported, 0 unchanged. ${VERSION_NOTICE}`)
      expect(lines(result.stderr)).toStrictEqual([READ_PROBLEM, `Sync finished with 1 problem: ${READ_PROBLEM}`])
    })
  })

  describe('progress', () => {
    it('writes a line at the first unit of an adapter, every tenth and its last unit, and sends every event to a channel', async () => {
      // Arrange
      const messages: SyncMessage[] = []

      // Act
      const result = await run(rereadingTwentyUnits, (message) => messages.push(message))

      // Assert
      expect(lines(result.stderr)).toStrictEqual([
        ...[1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20].map(
          (done) => `OpenCode: ${String(done)} of 20 read again for this version`
        ),
        'Working out the derived facts',
      ])
      expect(messages).toHaveLength(22)
      expect(messages.at(-2)).toStrictEqual({ type: 'phase', name: 'derivations' })
      expect(messages.at(-1)).toStrictEqual({ type: 'done', imported: 412, unchanged: 0, ms: 31_000, problems: [] })
    })

    it('sends progress, phase and done in order to a parent that forked it with a channel, and writes stderr too', async () => {
      // Act
      const result = await runChild(true)

      // Assert
      expect(result.code).toBe(0)
      expect(result.messages).toStrictEqual([
        { type: 'progress', adapter: 'claude-code', done: 1, total: 3, reread: false },
        { type: 'progress', adapter: 'claude-code', done: 2, total: 3, reread: false },
        { type: 'progress', adapter: 'claude-code', done: 3, total: 3, reread: false },
        { type: 'phase', name: 'derivations' },
        { type: 'done', imported: 2, unchanged: 1, ms: 1200, problems: [] },
      ])
      expect(lines(result.stderr)).toStrictEqual([
        'Claude Code: 1 of 3 checked',
        'Claude Code: 2 of 3 checked',
        'Claude Code: 3 of 3 checked',
        'Working out the derived facts',
      ])
    })

    it('writes stderr only and exits 0 in a child without a channel', async () => {
      // Act
      const result = await runChild(false)

      // Assert
      expect(result.code).toBe(0)
      expect(lines(result.stderr)).toStrictEqual([
        'Claude Code: 1 of 3 checked',
        'Claude Code: 2 of 3 checked',
        'Claude Code: 3 of 3 checked',
        'Working out the derived facts',
      ])
      expect(lines(result.stdout)[0]).toBe('# Sync')
    })
  })
})
