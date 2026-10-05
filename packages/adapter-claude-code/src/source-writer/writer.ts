import { access, mkdir, utimes, writeFile } from 'node:fs/promises'
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
import { LogBookError } from '@log-book/core'
import { projectSlug, ScriptWriter, type ITranscript, type IWriteContext } from './script-writer.js'

const TESTED_VERSIONS = ['2.1']
const CONFIG_DIRECTORY = '.claude'

const CAPABILITIES: ReadonlySet<SourceCapability> = new Set<SourceCapability>([
  'git-branch',
  'scripted',
  'image',
  'mcp-server',
  'typed-command',
  'nested-subagent',
  'tools-offered',
  'tools-loaded',
  'interrupt',
  'tool-reject',
])

const FAMILIES: ReadonlySet<ScriptFamily> = new Set<ScriptFamily>([
  'shell',
  'read',
  'edit',
  'search',
  'web',
  'todo',
  'question',
  'tool-search',
  'wait',
  'dispatch',
  'mcp',
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

const writeTranscript = async (home: string, transcript: ITranscript): Promise<void> => {
  const path = join(home, transcript.path)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, transcript.lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
  // The time of the last line, so equal scripts give equal fingerprints in two homes.
  const lastAt = new Date(transcript.lastAt)
  await utimes(path, lastAt, lastAt)
}

const commandPath = (home: string, file: ICommandFile): string =>
  join(
    file.projectDir === null
      ? join(home, CONFIG_DIRECTORY)
      : join(projectDirIn(home, file.projectDir), CONFIG_DIRECTORY),
    'commands',
    `${file.name}.md`
  )

// Writes Claude Code 2.1 transcripts, subagent transcripts and command files from scripts, and returns the records the
// adapter imports from them. Transcripts go under `<home>/.claude/projects/<slug>/`, where locate resolves them for a
// home with no variables.
export const claudeCodeSourceWriter = (): ISourceWriter => ({
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
      counters: { session: 0, message: 0, call: 0, request: 0, agent: 0 },
      ids: new Map(),
      transcripts: [],
      expected: [],
    }
    for (const script of scripts) {
      new ScriptWriter(context, script, {
        mainSessionId: ScriptWriter.mainSessionId(context.counters),
        projectPath: join(CONFIG_DIRECTORY, 'projects', projectSlug(script.projectDir)),
        agentId: null,
        spawnedBy: null,
      }).write()
    }
    const files = context.transcripts.map((transcript) => transcript.path)
    await refuseExisting(home, files)
    await Promise.all(context.transcripts.map(async (transcript) => writeTranscript(home, transcript)))
    return { expected: context.expected, ids: context.ids, files }
  },
})
