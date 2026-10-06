import { chmod, copyFile, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeCodeSourceWriter } from '@log-book/adapter-claude-code/source-writer'
import { openCodeSourceWriter } from '@log-book/adapter-opencode/source-writer'
import { WarehouseStore, type IHarnessRow, type ISyncRunRow } from '@log-book/warehouse'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLAN_CORPUS } from '../src/corpus/index.js'
import { MODELS } from '../src/corpus/models.js'
import { DEMO_ERROR_CODES } from '../src/errors.js'
import { importDemo } from '../src/import/import-demo.js'
import { planLabels } from '../src/plan/labels.js'
import { planDataset } from '../src/plan/planner.js'
import { scriptPlan } from '../src/plan/scripts.js'
import type { IPlanInputs, IWriterDeclaration } from '../src/plan/types.js'
import { demoWarehousePath } from '../src/sealed-environment.js'
import { writeDemo, type IWrittenDemo } from '../src/write/write-demo.js'

const WRITERS = [claudeCodeSourceWriter(), openCodeSourceWriter()] as const
const DECLARATIONS: readonly IWriterDeclaration[] = [
  { capabilities: [...WRITERS[0].capabilities], families: [...WRITERS[0].families], models: MODELS['claude-code'] },
  { capabilities: [...WRITERS[1].capabilities], families: [...WRITERS[1].families], models: MODELS.opencode },
]
const INPUTS: IPlanInputs = {
  size: 'small',
  seed: 1,
  anchor: Date.UTC(2026, 8, 28, 18),
  labels: 'all',
  model: null,
  corpus: PLAN_CORPUS,
  writers: DECLARATIONS,
}
const OPENCODE_DATABASE = 'home/.local/share/opencode/opencode.db'

const directories: string[] = []

const temporary = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'demo-import-'))
  directories.push(directory)
  return directory
}

// A home written from the small plan into `out`.
const writeSmall = async (out: string, seed = INPUTS.seed): Promise<IWrittenDemo> => {
  const inputs = { ...INPUTS, seed }
  const plan = planDataset(inputs)
  const writers = scriptPlan(plan, inputs)
  return writeDemo(
    out,
    { plan, writers, labels: planLabels(plan, writers, PLAN_CORPUS), ids: {}, showcase: null },
    WRITERS
  )
}

const isWarehouseWritten = async (out: string): Promise<boolean> =>
  open(demoWarehousePath(out), 'r').then(
    async (file) => {
      await file.close()
      return true
    },
    () => false
  )

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('importDemo', () => {
  it('imports the small home through the preflight, the sync and the comparison', async () => {
    // Arrange
    const out = await temporary()
    const written = await writeSmall(out)

    // Act
    await importDemo(out, written)

    // Assert
    const reader = await WarehouseStore.openReadOnly(demoWarehousePath(out))
    const harnesses = reader.all<Pick<IHarnessRow, 'location' | 'version_seen' | 'notice' | 'problem'>>(
      'SELECT location, version_seen, notice, problem FROM harness ORDER BY id'
    )
    const runs = reader.all<Pick<ISyncRunRow, 'outcome' | 'error'>>('SELECT outcome, error FROM sync_run')
    reader.close()
    expect({
      locations: harnesses.map((harness) => harness.location),
      isVersionSeen: harnesses.every((harness) => harness.version_seen !== null),
      notes: harnesses.flatMap((harness) => [harness.notice, harness.problem].filter((note) => note !== null)),
      runs,
    }).toStrictEqual({
      locations: ['~/.claude/projects', '~/.local/share/opencode/opencode.db'],
      isVersionSeen: true,
      notes: [],
      runs: [{ outcome: 'ok', error: null }],
    })
  })

  it("is sealed: a home of the test process's own, named by HOME and the harness variables, is never read", async () => {
    // Arrange
    const out = await temporary()
    const written = await writeSmall(out)
    const ownOut = await temporary()
    await writeSmall(ownOut, INPUTS.seed + 1)
    const ownHome = join(ownOut, 'home')
    vi.stubEnv('HOME', ownHome)
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(ownHome, '.claude'))
    vi.stubEnv('OPENCODE_DB', join(ownOut, OPENCODE_DATABASE))

    // Act
    await importDemo(out, written)

    // Assert
    const reader = await WarehouseStore.openReadOnly(demoWarehousePath(out))
    const sessions = reader.all<{ id: string }>('SELECT id FROM session ORDER BY id').map((session) => session.id)
    reader.close()
    expect(sessions).toStrictEqual(written.manifest.sessions)
  })

  it('stops at the preflight, before any warehouse exists, when a second OpenCode database lies in the home', async () => {
    // Arrange
    const out = await temporary()
    const written = await writeSmall(out)
    await copyFile(join(out, OPENCODE_DATABASE), join(out, 'home/.local/share/opencode/opencode-beta.db'))

    // Act
    const importing = importDemo(out, written)

    // Assert
    await expect(importing).rejects.toMatchObject({
      code: DEMO_ERROR_CODES.DEMO_PREFLIGHT_FAILED,
      message: expect.stringContaining('OpenCode') as string,
    })
    expect(await isWarehouseWritten(out)).toBe(false)
  })

  it('stops with the exit code of a partial sync when the OpenCode database cannot be read', async () => {
    // Arrange
    const out = await temporary()
    const written = await writeSmall(out)
    const database = join(out, OPENCODE_DATABASE)
    await chmod(database, 0o000)
    // Under root the file stays readable, and the case would prove nothing.
    await expect(open(database, 'r')).rejects.toThrow()

    // Act
    const importing = importDemo(out, written)

    // Assert
    await expect(importing).rejects.toMatchObject({
      code: DEMO_ERROR_CODES.DEMO_SYNC_FAILED,
      message: expect.stringContaining('exited 10') as string,
    })
    await chmod(database, 0o600)
  })

  it('names the record and the field of an expected record changed after writing, and no value', async () => {
    // Arrange
    const out = await temporary()
    const written = await writeSmall(out)
    const [first, ...rest] = written.expected
    if (first === undefined) {
      throw new Error('The small plan wrote no session')
    }
    const changed = [{ ...first, session: { ...first.session, title: 'Another title' } }, ...rest]

    // Act
    const importing = importDemo(out, { ...written, expected: changed })

    // Assert
    await expect(importing).rejects.toMatchObject({
      code: DEMO_ERROR_CODES.DEMO_IMPORT_MISMATCH,
      message: `The session ${first.session.id} differs from the expected record in its field title.`,
    })
  })

  it('stops before it starts a process when the built CLI is missing', async () => {
    // Arrange
    const out = await temporary()
    const written = await writeSmall(out)

    // Act
    const importing = importDemo(out, written, { cli: join(out, 'missing', 'cli.mjs') })

    // Assert
    await expect(importing).rejects.toMatchObject({
      code: DEMO_ERROR_CODES.DEMO_CLI_MISSING,
      message: 'the built CLI is missing; run pnpm build',
    })
    expect(await isWarehouseWritten(out)).toBe(false)
  })
})
