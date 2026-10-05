import { readFileSync } from 'node:fs'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IAdapterEnvironment } from '@log-book/adapter-api'
import type { IFixtureSet, ILocateVariant } from '@log-book/adapter-api/conformance'
import { openSqlite } from '@log-book/core'

const ROOT = fileURLToPath(new URL('2.0', import.meta.url))
const DATA_DIR = '.local/share/opencode'
const DATABASE = `${DATA_DIR}/opencode.db`
const SCHEMA = readFileSync(join(ROOT, 'opencode.sql'), 'utf8')
const ROWS = readFileSync(join(ROOT, 'rows.sql'), 'utf8')
  .split('\n')
  .filter((line) => line.startsWith('INSERT'))
// The rows a live database holds only in its write-ahead log.
const LIVE_ROWS = 3
// Later than any time in the set.
const CHANGED_AT = 1_800_000_000_000
const EARLIER = new Date('2026-01-01T00:00:00Z')
const LATER = new Date('2026-01-02T00:00:00Z')
const T0 = 1_772_532_000_000

const environment = (home: string, variables: Record<string, string> = {}): IAdapterEnvironment => ({
  variables,
  homeDir: home,
  cwd: home,
  platform: 'linux',
})

// opencode.sql keeps OpenCode's foreign keys to tables the adapter never reads, such as project, so the writer
// connection does not enforce them.
const writeDatabase = async (home: string): Promise<ReturnType<typeof openSqlite>> => {
  await mkdir(join(home, DATA_DIR), { recursive: true })
  const db = await openSqlite(join(home, DATABASE), { isReadOnly: false })
  db.exec('PRAGMA foreign_keys = OFF')
  return db
}

const withDatabase = async (home: string, sql: string): Promise<void> => {
  const db = await writeDatabase(home)
  db.exec(sql)
  db.close()
}

// Empty files at the given paths under the home, each with its modification time.
const files =
  (...entries: readonly (readonly [string, Date])[]) =>
  async (home: string): Promise<void> => {
    await Promise.all(
      entries.map(async ([path, time]) => {
        await mkdir(join(home, path, '..'), { recursive: true })
        await writeFile(join(home, path), '')
        await utimes(join(home, path), time, time)
      })
    )
  }

const BOTH_DATABASES = files(
  [DATABASE, EARLIER],
  [`${DATA_DIR}/opencode-local.db`, EARLIER],
  [`${DATA_DIR}/opencode-local.db-wal`, LATER]
)

// The rows of the OpenCode location rule.
const LOCATE_VARIANTS: readonly ILocateVariant[] = [
  {
    name: 'only opencode.db',
    arrange: files([DATABASE, EARLIER]),
    environment: (home) => environment(home),
    expected: { kind: 'found', root: DATABASE },
  },
  {
    name: 'only opencode-local.db',
    arrange: files([`${DATA_DIR}/opencode-local.db`, EARLIER]),
    environment: (home) => environment(home),
    expected: { kind: 'found', root: `${DATA_DIR}/opencode-local.db` },
  },
  {
    name: "both, with opencode-local.db's write-ahead log newest",
    arrange: BOTH_DATABASES,
    environment: (home) => environment(home),
    expected: { kind: 'found', root: `${DATA_DIR}/opencode-local.db` },
  },
  {
    name: 'OPENCODE_DISABLE_CHANNEL_DB=1',
    arrange: BOTH_DATABASES,
    environment: (home) => environment(home, { OPENCODE_DISABLE_CHANNEL_DB: '1' }),
    expected: { kind: 'found', root: DATABASE },
  },
  {
    name: 'OPENCODE_DISABLE_CHANNEL_DB=true',
    arrange: BOTH_DATABASES,
    environment: (home) => environment(home, { OPENCODE_DISABLE_CHANNEL_DB: 'true' }),
    expected: { kind: 'found', root: DATABASE },
  },
  {
    name: 'a migration backup only',
    arrange: files([`${DATA_DIR}/opencode.db.v1-backup.20260101`, EARLIER]),
    environment: (home) => environment(home),
    expected: { kind: 'not-found', lookedAt: DATABASE },
  },
  {
    name: 'OPENCODE_DB absolute',
    arrange: files(['elsewhere/chosen.db', EARLIER]),
    environment: (home) => environment(home, { OPENCODE_DB: join(home, 'elsewhere', 'chosen.db') }),
    expected: { kind: 'found', root: 'elsewhere/chosen.db' },
  },
  {
    name: 'OPENCODE_DB relative',
    arrange: files([`${DATA_DIR}/chosen.db`, EARLIER]),
    environment: (home) => environment(home, { OPENCODE_DB: 'chosen.db' }),
    expected: { kind: 'found', root: `${DATA_DIR}/chosen.db` },
  },
  {
    name: 'OPENCODE_DB :memory:',
    arrange: files([DATABASE, EARLIER]),
    environment: (home) => environment(home, { OPENCODE_DB: ':memory:' }),
    expected: { kind: 'not-found', lookedAt: null },
  },
  {
    name: 'XDG_DATA_HOME absolute',
    arrange: files(['xdg/opencode/opencode.db', EARLIER]),
    environment: (home) => environment(home, { XDG_DATA_HOME: join(home, 'xdg') }),
    expected: { kind: 'found', root: 'xdg/opencode/opencode.db' },
  },
  {
    name: 'XDG_DATA_HOME relative',
    arrange: files([DATABASE, EARLIER]),
    environment: (home) => environment(home, { XDG_DATA_HOME: 'xdg' }),
    expected: { kind: 'found', root: DATABASE },
  },
]

const session = (number: number): string => `ses_example${String(number).padStart(2, '0')}`

// The OpenCode 2.0 database, built from opencode.sql and rows.sql at test time; README.md says what each session
// exercises.
export const fixtureSet20: IFixtureSet = {
  harnessVersion: '2.0',
  root: ROOT,
  locationKind: 'file',
  units: [
    {
      locator: session(1),
      harnessVersion: '2.0.21',
      unknownRecords: [
        {
          id: 'msg_example09',
          type: 'brand-new-kind',
          seq: 9,
          time_created: T0 + 50_000,
          time_updated: T0 + 50_000,
          data: `{"detail":"a type this adapter does not know","time":{"created":${String(T0 + 50_000)}}}`,
        },
        '{"text":"a row whose data was cut',
      ],
    },
    { locator: session(2), harnessVersion: '1.18.34', unknownRecords: [] },
    ...[3, 4, 5, 6, 7, 8].map((number) => ({ locator: session(number), harnessVersion: '2.0.21', unknownRecords: [] })),
    { locator: session(9), harnessVersion: '2.1.4', unknownRecords: [] },
    { locator: session(10), harnessVersion: '2.0.21', unknownRecords: [{ type: 'step-marker', step: 1 }] },
    { locator: session(11), harnessVersion: '2.0.21', unknownRecords: [] },
    { locator: session(12), harnessVersion: '2.0.21', unknownRecords: [] },
    { locator: session(13), harnessVersion: '1.18.34', unknownRecords: [] },
  ],
  environment: (home) => environment(home, { OPENCODE_DB: join(home, DATABASE) }),
  // Journal mode DELETE, so a read-only open adds no file.
  prepare: async (home) => {
    const db = await writeDatabase(home)
    db.exec(SCHEMA)
    db.exec(ROWS.join('\n'))
    db.close()
  },
  // As OpenCode leaves it while running: write-ahead log on, no automatic checkpoint, the last rows only in the
  // `-wal`, and the writer still open.
  prepareLive: async (home) => {
    const db = await writeDatabase(home)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA wal_autocheckpoint = 0')
    db.exec(SCHEMA)
    db.exec(ROWS.slice(0, -LIVE_ROWS).join('\n'))
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.exec(ROWS.slice(-LIVE_ROWS).join('\n'))
    return () => {
      db.close()
    }
  },
  change: async (home, locator) => {
    await withDatabase(
      home,
      `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
       VALUES ('msg_example99', '${locator}', 'user', 99, ${String(CHANGED_AT)}, ${String(CHANGED_AT)}, '{"text":"one more thing"}');`
    )
  },
  remove: async (home, locator) => {
    await withDatabase(
      home,
      `DELETE FROM session_message WHERE session_id = '${locator}'; DELETE FROM session_v2 WHERE id = '${locator}';`
    )
  },
  locateVariants: LOCATE_VARIANTS,
  neverRead: [
    `${DATA_DIR}/auth.json`,
    '.config/opencode/opencode.json',
    '.config/opencode/skills/review-checklist/SKILL.md',
    'work/shop/AGENTS.md',
  ],
}

// The schema with one column taken out, for the adapter's own missing-column case.
export const schemaWithout = (table: string, column: string): string =>
  SCHEMA.replace(new RegExp(`(CREATE TABLE [\`"]?${table}[\`"]? \\([\\s\\S]*?)\\s*\`${column}\` [^,]*,`, 'u'), '$1')
