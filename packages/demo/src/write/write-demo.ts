import { createHash } from 'node:crypto'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ISourceWriter, IWrittenSource } from '@log-book/adapter-api/source-writer'
import type { IImportedSession } from '@log-book/warehouse'
import { DEMO_CORPUS_MARK } from '../corpus/index.js'
import type { DemoSize, IDemoPlan, LabelsVariant } from '../plan/types.js'
import { canonicalDump } from './canonical-dump.js'

const HOME_DIRECTORY = 'home'
export const PLAN_FILE = 'plan.json'
export const MANIFEST_FILE = 'manifest.json'

const SQLITE_HEADER = 'SQLite format 3\u0000'

interface IManifestBuild {
  size: DemoSize
  seed: number
  labels: LabelsVariant
  // Absent when no labels are planned.
  model?: string
  // ISO 8601 in UTC.
  anchor: string
}

interface IManifest {
  build: IManifestBuild
  corpusMark: string
  // Every file written, by its path relative to the out directory, with the SHA-256 of its bytes, or of its canonical
  // dump for a SQLite database.
  files: Record<string, string>
  sessions: string[]
  texts: string[]
}

export interface IWrittenDemo {
  plan: IDemoPlan
  manifest: IManifest
  // What the adapters will import from the home: every session the writers wrote.
  expected: readonly IImportedSession[]
  // Every file the writers wrote, relative to the home.
  homeFiles: readonly string[]
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

const byCodeUnit = (left: string, right: string): number => {
  if (left === right) {
    return 0
  }
  return left < right ? -1 : 1
}

const isSqlite = async (path: string): Promise<boolean> => {
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    return bytesRead === header.length && header.toString('latin1') === SQLITE_HEADER
  } finally {
    await file.close()
  }
}

const fileHash = async (path: string): Promise<string> =>
  (await isSqlite(path)) ? sha256(await canonicalDump(path, 'sqlite')) : sha256(await readFile(path))

// The texts the check traces in the expected records: part text, session title and project directory, message model
// and tool call input as stored.
const textsOf = (sessions: readonly IImportedSession[]): string[] =>
  sessions.flatMap((imported) => [
    ...imported.parts.map((part) => part.text),
    ...[imported.session.title, imported.session.projectDir].flatMap((text) => (text === null ? [] : [text])),
    ...imported.messages.flatMap((message) => (message.model === null ? [] : [message.model])),
    ...imported.toolCalls.map((call) => call.inputJson),
  ])

// The plan's own facts: the size, seed, labels variant, labelling model and anchor of the build.
const buildOf = (demo: IDemoPlan): IManifestBuild => {
  const { plan } = demo
  return {
    size: plan.size,
    seed: plan.seed,
    labels: plan.labels,
    ...(plan.labelModel === null ? {} : { model: plan.labelModel }),
    anchor: new Date(plan.anchor).toISOString(),
  }
}

// Every plan key's record id from the writers' ids maps; a key two writers gave would make the ids ambiguous.
const idsOf = (written: readonly IWrittenSource[]): Record<string, string> => {
  const ids: Record<string, string> = {}
  for (const [key, id] of written.flatMap((source) => [...source.ids])) {
    if (key in ids) {
      throw new Error(`Two writers gave the plan key ${key} a record id`)
    }
    ids[key] = id
  }
  return ids
}

// Writes the plan as a harness user's home holds it into `<out>/home`, one writeCommandFiles and then one writeSessions
// call per writer, then plan.json, then manifest.json with the hash of everything written. A writer
// that refuses a script stops the write with its own error, which names the script key.
export const writeDemo = async (
  out: string,
  demo: IDemoPlan,
  writers: readonly ISourceWriter[]
): Promise<IWrittenDemo> => {
  const home = join(out, HOME_DIRECTORY)
  await mkdir(home, { recursive: true })
  // Each writer writes files of its own, so the writers run side by side.
  const results = await Promise.all(
    writers.map(async (writer, index) => {
      const scripts = demo.writers[index]
      if (scripts === undefined) {
        throw new Error(`The plan has no scripts for writer ${String(index)}`)
      }
      const commandFiles = await writer.writeCommandFiles(home, scripts.commandFiles)
      const source = await writer.writeSessions(home, scripts.scripts)
      return { files: [...commandFiles, ...source.files], source }
    })
  )
  const files = results.flatMap((result) => result.files)
  const written: IWrittenSource[] = results.map((result) => result.source)
  const plan: IDemoPlan = { ...demo, ids: idsOf(written) }
  await writeFile(join(out, PLAN_FILE), JSON.stringify(plan))
  const paths = [...files.map((file) => join(HOME_DIRECTORY, file)), PLAN_FILE].toSorted(byCodeUnit)
  const hashes = await Promise.all(paths.map(async (path) => [path, await fileHash(join(out, path))] as const))
  const expected = written.flatMap((source) => source.expected)
  const manifest: IManifest = {
    build: buildOf(plan),
    corpusMark: DEMO_CORPUS_MARK,
    files: Object.fromEntries(hashes),
    sessions: expected.map((imported) => imported.session.id).toSorted(byCodeUnit),
    texts: [...new Set(textsOf(expected).map(sha256))].toSorted(byCodeUnit),
  }
  await writeFile(join(out, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
  return { plan, manifest, expected, homeFiles: files }
}
