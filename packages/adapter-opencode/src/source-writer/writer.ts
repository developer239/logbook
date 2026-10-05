import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  checkCommandFiles,
  checkScripts,
  projectDirIn,
  SOURCE_WRITER_ERROR_CODES,
  type ICommandFile,
  type ISessionScript,
  type ISourceWriter,
  type IWrittenSource,
  type ScriptFamily,
  type SourceCapability,
} from '@log-book/adapter-api/source-writer'
import { LogBookError, openSqlite } from '@log-book/core'
import { SessionWriter, type IWriteContext } from './session-writer.js'

const TESTED_VERSIONS = ['2.0']
// The one database the writer writes, never a channel-named one: where locate resolves it for a home with no
// variables.
const DATABASE = join('.local', 'share', 'opencode', 'opencode.db')
// Fixture set 2.0's schema, the tables the adapter reads as OpenCode 2.0.21 creates them.
const SCHEMA = new URL('../../fixtures/2.0/opencode.sql', import.meta.url)

const CAPABILITIES: ReadonlySet<SourceCapability> = new Set<SourceCapability>([
  'session-agent',
  'scripted',
  'image',
  'reported-cost',
  'template-command',
  'model-switch',
  'agent-switch',
  'idle-event',
  'interrupt',
  'tool-reject',
])

const FAMILIES: ReadonlySet<ScriptFamily> = new Set<ScriptFamily>([
  'shell',
  'read',
  'edit',
  'search',
  'web',
  'question',
  'wait',
  'dispatch',
  'other',
])

const isPresent = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

// Nothing is written when any target exists: a home takes one writeSessions call per writer.
const refuseExisting = async (home: string, paths: readonly string[]): Promise<void> => {
  const present = await Promise.all(paths.map(async (path) => ((await isPresent(join(home, path))) ? [path] : [])))
  const [first] = present.flat()
  if (first !== undefined) {
    throw new LogBookError(`${first} exists in ${home}.`, SOURCE_WRITER_ERROR_CODES.WRITER_TARGET_EXISTS)
  }
}

const insert = (table: string, rows: readonly Record<string, string | number | null>[]): string[] =>
  rows.map((row) => {
    const columns = Object.keys(row)
    return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  })

// Journal mode DELETE, so a read-only open adds no file. The schema keeps OpenCode's foreign keys to tables the
// adapter never reads, such as project, so they are not enforced while writing.
const writeDatabase = async (path: string, context: IWriteContext): Promise<void> => {
  const schema = await readFile(SCHEMA, 'utf8')
  await mkdir(dirname(path), { recursive: true })
  const db = await openSqlite(path, { isReadOnly: false })
  try {
    db.exec('PRAGMA journal_mode = DELETE')
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec(schema)
    db.exec('BEGIN')
    for (const [table, rows] of [
      ['session_v2', context.sessionRows],
      ['session_message', context.messageRows],
    ] as const) {
      const statements = insert(table, rows)
      rows.forEach((row, index) => {
        db.prepare(statements[index] ?? '').run(...Object.values(row))
      })
    }
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

const commandPath = (home: string, file: ICommandFile): string =>
  file.projectDir === null
    ? join(home, '.config', 'opencode', 'commands', `${file.name}.md`)
    : join(projectDirIn(home, file.projectDir), '.opencode', 'commands', `${file.name}.md`)

// Writes OpenCode 2.0's database and command files from scripts, and returns the records the adapter imports from
// them.
export const openCodeSourceWriter = (): ISourceWriter => ({
  capabilities: CAPABILITIES,
  families: FAMILIES,
  writeCommandFiles: async (home, files) => {
    checkCommandFiles(files)
    const paths = files.map((file) => commandPath(home, file).slice(home.length + 1))
    await refuseExisting(home, paths)
    await Promise.all(
      files.map(async (file, index) => {
        const path = join(home, paths[index] ?? '')
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, file.body)
      })
    )
    return paths
  },
  writeSessions: async (home, scripts: readonly ISessionScript[]): Promise<IWrittenSource> => {
    checkScripts({ capabilities: CAPABILITIES, families: FAMILIES }, scripts, TESTED_VERSIONS)
    const context: IWriteContext = {
      counters: { session: 0, message: 0, part: 0 },
      ids: new Map(),
      sessionRows: [],
      messageRows: [],
      expected: [],
    }
    for (const script of scripts) {
      new SessionWriter(context, script, null).write()
    }
    await refuseExisting(home, [DATABASE])
    await writeDatabase(join(home, DATABASE), context)
    return { expected: context.expected, ids: context.ids, files: [DATABASE] }
  },
})
