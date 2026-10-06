import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { gitWorkspaces } from '../testing/git-workspace.js'
import { releaseNotes, schemaVersionAt } from './release-notes.js'

const run = promisify(execFile)
const MIGRATIONS_FILE = 'packages/warehouse/src/migrations.ts'
const VERSIONS_FILE = 'packages/engine/src/labels/tasks/versions.json'
const TASKS = { 'shell': 3, 'tool-failure': 1, 'session': 2, 'outcome': 1, 'prompt': 2, 'reply': 1 }
const workspaces = gitWorkspaces()

// A migrations module as the warehouse writes it: comments, template literals holding brackets, commas and a
// placeholder, and a trailing comma.
const migrations = (count: number): string =>
  [
    '// Rules for every migration after version 1; MIGRATIONS is appended to, never edited.',
    'const TABLE = "label"',
    'export const MIGRATIONS: readonly string[] = [',
    ...Array.from({ length: count }, (_unused, index) =>
      [
        `  // Version ${String(index + 1)}: a table, (a, b), [c].`,
        `  \`CREATE TABLE t${String(index)} (a, b); -- ] \${TABLE}\`,`,
      ].join('\n')
    ),
    ']',
    '',
    'export const SCHEMA_VERSION = MIGRATIONS.length',
    '',
  ].join('\n')

const plant = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  await Promise.all(
    Object.entries(files).map(async ([path, text]) => {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), text)
    })
  )
}

const git = async (root: string, ...args: string[]): Promise<void> => {
  await run('git', ['-c', 'user.name=Example', '-c', 'user.email=example@example.com', ...args], { cwd: root })
}

// A repository with a commit tagged v1.0.0 holding these files, then one tagged v1.1.0 with the changes planted over
// them.
const repository = async (
  files: Readonly<Record<string, string>>,
  changes: Readonly<Record<string, string>> = {}
): Promise<string> => {
  const root = await workspaces.create(files)
  await git(root, 'commit', '-q', '-m', 'feat: the first release')
  await git(root, 'tag', 'v1.0.0')
  await plant(root, changes)
  await git(root, 'add', '-A')
  await git(root, 'commit', '-q', '--allow-empty', '-m', 'feat: the next release')
  await git(root, 'tag', 'v1.1.0')
  return root
}

const baseline = { [MIGRATIONS_FILE]: migrations(1), [VERSIONS_FILE]: JSON.stringify(TASKS, null, 2) }

afterEach(async () => {
  await workspaces.removeAll()
})

describe('releaseNotes', () => {
  it('gives the migration line and one task line for one more migration and one task version raised', async () => {
    // Arrange
    const root = await repository(baseline, {
      [MIGRATIONS_FILE]: migrations(2),
      [VERSIONS_FILE]: JSON.stringify({ ...TASKS, prompt: 3 }, null, 2),
    })

    // Act
    const lines = await releaseNotes(root, 'v1.0.0', 'v1.1.0')

    // Assert
    expect(lines).toStrictEqual([
      'This version migrates the warehouse to schema 2. Earlier versions of Log Book cannot open it afterwards (exit 6).',
      'This version changes the labelling task `prompt` from version 2 to 3. The next `logbook labels update` labels ' +
        'again everything that task labelled, on your own Claude plan; `logbook labels plan` prints the estimate for ' +
        'your warehouse before any call is made.',
    ])
  })

  it('gives nothing for the first release, and nothing when schema and task versions are the same', async () => {
    // Arrange
    const root = await repository(baseline, { 'README.md': 'A change that costs users nothing.\n' })

    // Act
    const lines = [await releaseNotes(root, '', 'v1.0.0'), await releaseNotes(root, 'v1.0.0', 'v1.1.0')]

    // Assert
    expect(lines).toStrictEqual([[], []])
  })

  it('stops, naming the task, when a task is missing at the previous tag', async () => {
    // Arrange
    const { reply: _reply, ...withoutReply } = TASKS
    const root = await repository(
      { ...baseline, [VERSIONS_FILE]: JSON.stringify(withoutReply) },
      {
        [VERSIONS_FILE]: JSON.stringify(TASKS),
      }
    )

    // Act
    const notes = releaseNotes(root, 'v1.0.0', 'v1.1.0')

    // Assert
    await expect(notes).rejects.toThrow(
      `${VERSIONS_FILE} names the task reply at only one of v1.0.0 and v1.1.0; a release that adds or removes a task ` +
        'has its note written by hand.'
    )
  })
})

describe('schemaVersionAt', () => {
  it('counts the entries of MIGRATIONS at each ref, past comments, brackets, commas and placeholders in them', async () => {
    // Arrange
    const root = await repository(baseline, { [MIGRATIONS_FILE]: migrations(3) })

    // Act
    const versions = [await schemaVersionAt(root, 'v1.0.0'), await schemaVersionAt(root, 'v1.1.0')]

    // Assert
    expect(versions).toStrictEqual([1, 3])
  })

  it('stops, naming the ref, when the warehouse source declares MIGRATIONS twice', async () => {
    // Arrange
    const root = await repository(baseline, {
      'packages/warehouse/src/legacy.ts': 'export const MIGRATIONS = []\n',
    })

    // Act
    const version = schemaVersionAt(root, 'v1.1.0')

    // Assert
    await expect(version).rejects.toThrow(
      'v1.1.0: packages/warehouse/src/ declares MIGRATIONS 2 times, not exactly once.'
    )
  })
})
