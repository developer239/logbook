import { existsSync } from 'node:fs'
import { readdir, readFile, realpath, rm } from 'node:fs/promises'
import { homedir, hostname, userInfo } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { LogBookError, openSqlite, type ISqliteDb } from '@log-book/core'
import { LABEL_TASKS, type ILabelFieldInfo } from '@log-book/engine'
import { RULES_LABELLER } from '@log-book/warehouse'
import { DEMO_ERROR_CODES } from '../errors.js'
import type { IDemoPlan } from '../plan/types.js'
import { demoWarehousePath } from '../sealed-environment.js'
import { canonicalDump, isDerivedTable } from '../write/canonical-dump.js'
import {
  fileHash,
  HOME_DIRECTORY,
  isSqlite,
  MANIFEST_FILE,
  PLAN_FILE,
  sha256,
  type IManifest,
} from '../write/write-demo.js'
import { recordOf } from '../write/write-labels.js'

export type DemoRule = 'C1' | 'C2' | 'C3' | 'C4' | 'C5'

// A rule the out directory breaks, and where: a file and line, or a table, column and row. Never the text it found, so
// a report of a failure cannot leak it.
export interface IDemoFinding {
  rule: DemoRule
  location: string
}

// A text and where it sits.
interface IPlacedText {
  location: string
  text: string
}

interface ITable {
  name: string
  sql: string
}

// Log Book's own data directory in the demo home, which the build's sync writes and the manifest leaves out.
const LOG_BOOK_DATA = `${HOME_DIRECTORY}/.local/share/log-book/`
// The tables whose rows belong to a session, by the columns that name it.
const SESSION_COLUMNS: readonly (readonly [string, string])[] = [
  ['message', 'session_id'],
  ['part', 'session_id'],
  ['tool_call', 'session_id'],
  ['event', 'session_id'],
  ['turn', 'session_id'],
  ['session_command', 'session_id'],
  ['link', 'parent_session_id'],
  ['link', 'child_session_id'],
]
// The columns whose text the writers wrote from the corpus, which the manifest's texts hold.
const TRACED_COLUMNS: readonly (readonly [string, string])[] = [
  ['part', 'text'],
  ['session', 'title'],
  ['session', 'project_dir'],
  ['message', 'model'],
  ['tool_call', 'input_json'],
]
const INVENTED_HOME = '/home/example/'
// An absolute path under a directory that holds a machine's users or temporary files, not inside a word or a URL.
const MACHINE_PATH = /(?<![\w.:/~-])\/(?:home|Users|root|private|var|tmp|Volumes|mnt)\/[^\s"'`<>()[\]{},;]*/gu
const UUID = /\b(?<first>[0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu
const SOURCE_ID = /\b(?:ses|msg|prt|toolu|req)_[A-Za-z0-9]+/gu
const INVENTED_SOURCE_ID = /^(?:ses|msg|prt|toolu|req)_demo\d+$/u
// A subagent's id holds a digit; `agent-switch` and its kin name an event.
const AGENT_ID = /\bagent-(?=[A-Za-z]*\d)[A-Za-z0-9]+/gu
const INVENTED_AGENT_ID = /^agent-demo\d+$/u
const EMAIL_DOMAIN = /[\w.+-]+@(?<domain>[\w-]+(?:\.[\w-]+)*\.[a-z]{2,})\b/giu
const INVENTED_UUID = 'de30da7a'
const INVENTED_EMAIL_DOMAIN = 'example.com'
const MIN_WORD = 3

const FIELDS = new Map(
  LABEL_TASKS.flatMap((task) => task.fields.map((field) => [`${field.recordType}/${field.name}`, field]))
)

const finding = (rule: DemoRule, location: string): IDemoFinding => ({ rule, location })

const escaped = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')

const linesOf = (location: string, text: string): IPlacedText[] =>
  text.split('\n').map((line, index) => ({ location: `${location}:${String(index + 1)}`, text: line }))

// Every file below the home but Log Book's own data, by its path from the out directory, with `/` between segments.
const homeFilesOf = async (root: string): Promise<string[]> =>
  (await readdir(join(root, HOME_DIRECTORY), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((path) => !path.startsWith(LOG_BOOK_DATA))
    .toSorted()

// C1: the home and the plan file are exactly what the manifest records.
const filesFindings = async (
  root: string,
  manifest: IManifest,
  homeFiles: readonly string[]
): Promise<IDemoFinding[]> => {
  const recorded = Object.keys(manifest.files).filter((path) => path.startsWith(`${HOME_DIRECTORY}/`))
  const present = new Set(homeFiles)
  const changed = await Promise.all(
    [...homeFiles.filter((path) => path in manifest.files), PLAN_FILE].map(async (path) =>
      existsSync(join(root, path)) && (await fileHash(join(root, path))) === manifest.files[path] ? [] : [path]
    )
  )
  return [
    ...homeFiles.filter((path) => !(path in manifest.files)),
    ...recorded.filter((path) => !present.has(path)),
    ...changed.flat(),
  ]
    .toSorted()
    .map((path) => finding('C1', path))
}

const tablesOf = (db: ISqliteDb): ITable[] =>
  (
    db
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
      )
      .all() as unknown as ITable[]
  ).filter((table) => !isDerivedTable(table.name))

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`

const ROWID = 'check_rowid'

// The rows of a table with a key that names each without its contents: its rowid, or its place in primary key order
// for a table without one.
const keyedRows = (
  db: ISqliteDb,
  table: ITable,
  columns: readonly string[]
): { key: string; row: Record<string, unknown> }[] => {
  const selected = columns.map(quoted).join(', ')
  if (!/WITHOUT ROWID/iu.test(table.sql)) {
    return (
      db
        .prepare(`SELECT rowid AS ${ROWID}, ${selected} FROM ${quoted(table.name)} ORDER BY rowid`)
        .all() as unknown as Record<string, unknown>[]
    ).map((row) => ({ key: `rowid ${String(row[ROWID])}`, row }))
  }
  const keys = (
    db.prepare(`PRAGMA table_info(${quoted(table.name)})`).all() as unknown as { name: string; pk: number }[]
  )
    .filter((column) => column.pk > 0)
    .toSorted((left, right) => left.pk - right.pk)
    .map((column) => quoted(column.name))
  return (
    db.prepare(`SELECT ${selected} FROM ${quoted(table.name)} ORDER BY ${keys.join(', ')}`).all() as unknown as Record<
      string,
      unknown
    >[]
  ).map((row, index) => ({ key: `row ${String(index + 1)}`, row }))
}

const tableNamed = (tables: readonly ITable[], name: string): ITable => {
  const table = tables.find((candidate) => candidate.name === name)
  if (table === undefined) {
    throw new Error(`The warehouse has no table ${name}`)
  }
  return table
}

// Each value of one column with its location, `<table>.<column> <row key>`.
const columnOf = (db: ISqliteDb, tables: readonly ITable[], name: string, column: string): IPlacedText[] =>
  keyedRows(db, tableNamed(tables, name), [column]).flatMap(({ key, row }) => {
    const value = row[column]
    return value === null || value === undefined ? [] : [{ location: `${name}.${column} ${key}`, text: String(value) }]
  })

// C2: the warehouse holds exactly the planned sessions, and what refers to them, what the home holds.
const sessionFindings = (db: ISqliteDb, tables: readonly ITable[], manifest: IManifest): IDemoFinding[] => {
  const planned = new Set(manifest.sessions)
  const stored = columnOf(db, tables, 'session', 'id')
  const storedIds = new Set(stored.map((placed) => placed.text))
  const harnesses = new Set(manifest.sessions.map((id) => id.split(':')[0]))
  const sourceIds = new Set(manifest.sessions.map((id) => id.slice(id.indexOf(':') + 1)))
  const files = Object.keys(manifest.files)
  const isHeld = (locator: string): boolean =>
    sourceIds.has(locator) || files.some((path) => path.endsWith(`/${locator}`))
  return [
    ...stored.filter((placed) => !planned.has(placed.text)).map((placed) => finding('C2', placed.location)),
    ...manifest.sessions.flatMap((id, index) =>
      storedIds.has(id) ? [] : [finding('C2', `session.id manifest sessions[${String(index)}]`)]
    ),
    ...SESSION_COLUMNS.flatMap(([table, column]) =>
      columnOf(db, tables, table, column)
        .filter((placed) => !planned.has(placed.text))
        .map((placed) => finding('C2', placed.location))
    ),
    ...columnOf(db, tables, 'source_state', 'locator')
      .filter((placed) => !isHeld(placed.text))
      .map((placed) => finding('C2', placed.location)),
    ...columnOf(db, tables, 'harness', 'id')
      .filter((placed) => !harnesses.has(placed.text))
      .map((placed) => finding('C2', placed.location)),
  ]
}

const labelKey = (recordType: string, recordId: string, labeller: string, version: number, name: string): string =>
  [recordType, recordId, labeller, String(version), name].join('\n')

const isInVocabulary = (field: ILabelFieldInfo, value: string): boolean => {
  const values = new Set(field.values)
  return field.kind === 'codes' ? value.split(',').every((code) => values.has(code)) : values.has(value)
}

interface ILabelRow {
  record_type: string
  record_id: string
  labeller: string
  version: number
  name: string
  value: string
}

const LABEL_COLUMNS = ['record_type', 'record_id', 'labeller', 'version', 'name', 'value'] as const

// A model label traces when its field's vocabulary holds its value, or, for a field of free text or references, when
// the plan gives it that value.
const isTraced = (label: ILabelRow, planned: ReadonlyMap<string, string>): boolean => {
  const field = FIELDS.get(`${label.record_type}/${label.name}`)
  if (field === undefined) {
    return false
  }
  return field.values === null
    ? planned.get(labelKey(label.record_type, label.record_id, label.labeller, label.version, label.name)) ===
        label.value
    : isInVocabulary(field, label.value)
}

// C3: every text traces to the corpus, and every model label is the engine's vocabulary or the plan's value.
const traceFindings = (
  db: ISqliteDb,
  tables: readonly ITable[],
  manifest: IManifest,
  plan: IDemoPlan | null
): IDemoFinding[] => {
  const texts = new Set(manifest.texts)
  const planned = new Map(
    (plan?.labels.labels ?? []).map((label) => {
      const record = recordOf(plan?.ids ?? {}, label)
      return [labelKey(record.recordType, record.recordId, record.labeller, record.version, record.name), record.value]
    })
  )
  const labels = keyedRows(db, tableNamed(tables, 'label'), LABEL_COLUMNS).flatMap(({ key, row }) => {
    const label = row as unknown as ILabelRow
    return label.labeller === RULES_LABELLER || isTraced(label, planned) ? [] : [finding('C3', `label.value ${key}`)]
  })
  return [
    ...TRACED_COLUMNS.flatMap(([table, column]) =>
      columnOf(db, tables, table, column)
        .filter((placed) => !texts.has(sha256(placed.text)))
        .map((placed) => finding('C3', placed.location))
    ),
    ...labels,
  ]
}

// Every text column of every table the warehouse stores, its derived index left out.
const warehouseTexts = (db: ISqliteDb, tables: readonly ITable[]): IPlacedText[] =>
  tables.flatMap((table) =>
    (db.prepare(`PRAGMA table_info(${quoted(table.name)})`).all() as unknown as { name: string; type: string }[])
      .filter((column) => column.type.toUpperCase() === 'TEXT')
      .flatMap((column) => columnOf(db, tables, table.name, column.name))
  )

// The texts C4 and C5 read outside the warehouse: the manifest, the plan file and every file C1 covers, a SQLite file
// by its canonical dump.
const fileTexts = async (root: string, homeFiles: readonly string[]): Promise<IPlacedText[]> =>
  (
    await Promise.all(
      [MANIFEST_FILE, PLAN_FILE, ...homeFiles]
        .filter((path) => existsSync(join(root, path)))
        .map(async (path) => {
          const file = join(root, path)
          return linesOf(
            path,
            (await isSqlite(file)) ? await canonicalDump(file, 'sqlite') : await readFile(file, 'utf8')
          )
        })
    )
  ).flat()

// The facts of the machine that runs the check: its home, the out directory as given and with links resolved, the user
// name and the host name as whole words.
const machineFacts = async (out: string): Promise<RegExp[]> => {
  const paths = [...new Set([homedir(), resolve(out), await realpath(out)])]
  const words = [userInfo().username, hostname()].filter((word) => word.length >= MIN_WORD)
  return [
    ...paths.map((path) => new RegExp(escaped(path), 'u')),
    ...words.map((word) => new RegExp(`\\b${escaped(word)}\\b`, 'iu')),
  ]
}

// C5: every shape a machine would leave is the invented one.
const isInventedOnly = (text: string): boolean =>
  [...text.matchAll(MACHINE_PATH)].every(([path]) => `${path}/`.startsWith(INVENTED_HOME)) &&
  [...text.matchAll(UUID)].every((match) => match.groups?.first?.toLowerCase() === INVENTED_UUID) &&
  [...text.matchAll(SOURCE_ID)].every(([id]) => INVENTED_SOURCE_ID.test(id)) &&
  [...text.matchAll(AGENT_ID)].every(([id]) => INVENTED_AGENT_ID.test(id)) &&
  [...text.matchAll(EMAIL_DOMAIN)].every((match) => match.groups?.domain?.toLowerCase() === INVENTED_EMAIL_DOMAIN)

const readPlan = async (root: string): Promise<IDemoPlan | null> => {
  try {
    return JSON.parse(await readFile(join(root, PLAN_FILE), 'utf8')) as IDemoPlan
  } catch {
    return null
  }
}

const readManifest = async (root: string): Promise<IManifest> => {
  try {
    return JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8')) as IManifest
  } catch {
    throw new LogBookError(
      `${root} holds no demo build: its ${MANIFEST_FILE} cannot be read`,
      DEMO_ERROR_CODES.DEMO_OUT_NOT_DEMO
    )
  }
}

// Checks an out directory against its manifest by rules C1 to C5, unsealed, so it knows the facts of the machine it
// must not find. Resolves to every finding, none when the directory passes.
export const checkDemo = async (out: string): Promise<IDemoFinding[]> => {
  const root = resolve(out)
  const manifest = await readManifest(root)
  const homeFiles = await homeFilesOf(root)
  const facts = await machineFacts(out)
  const db = await openSqlite(demoWarehousePath(root), { isReadOnly: true })
  try {
    const tables = tablesOf(db)
    const texts = [...warehouseTexts(db, tables), ...(await fileTexts(root, homeFiles))]
    const placesOf = (rule: DemoRule, isBroken: (text: string) => boolean): IDemoFinding[] =>
      [...new Set(texts.filter((placed) => isBroken(placed.text)).map((placed) => placed.location))].map((location) =>
        finding(rule, location)
      )
    return [
      ...(await filesFindings(root, manifest, homeFiles)),
      ...sessionFindings(db, tables, manifest),
      ...traceFindings(db, tables, manifest, await readPlan(root)),
      ...placesOf('C4', (text) => facts.some((fact) => fact.test(text))),
      ...placesOf('C5', (text) => !isInventedOnly(text)),
    ]
  } finally {
    db.close()
  }
}

// The build's last step: a finding removes the warehouse, with its write-ahead log, and stops the build naming the
// first finding.
export const checkBuild = async (out: string): Promise<void> => {
  const [first] = await checkDemo(out)
  if (first === undefined) {
    return
  }
  const warehouse = demoWarehousePath(out)
  await Promise.all(['', '-wal', '-shm'].map(async (suffix) => rm(`${warehouse}${suffix}`, { force: true })))
  throw new LogBookError(`The demo build breaks ${first.rule} at ${first.location}`, DEMO_ERROR_CODES.DEMO_CHECK_FAILED)
}
