import { readFileSync } from 'node:fs'
import { appendFile, mkdir, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IAdapterEnvironment } from '@log-book/adapter-api'
import type { IFixtureSet, ILocateVariant } from '@log-book/adapter-api/conformance'

const ROOT = fileURLToPath(new URL('2.1', import.meta.url))
const CONFIG_DIR_VARIABLE = 'CLAUDE_CONFIG_DIR'
const PROJECTS = join('.claude', 'projects')
// Later than any time in the set, so a changed transcript's fingerprint never depends on the clock's resolution.
const CHANGED_AT = new Date('2027-01-01T00:00:00Z')
const SHOP = '-home-example-work-shop'
const BILLING = '-home-example-work-billing'

const environment = (home: string, variables: Record<string, string> = {}, cwd = home): IAdapterEnvironment => ({
  variables,
  homeDir: home,
  cwd,
  platform: 'linux',
})

const session = (project: string, number: number): string =>
  `${project}/5f0c2a1e-0000-4000-8000-${String(number).padStart(12, '0')}.jsonl`

// The committed lines of a transcript, so a unit declares its unknown records by line number instead of copying them.
const linesOf = (locator: string): string[] => readFileSync(join(ROOT, 'home', PROJECTS, locator), 'utf8').split('\n')

const lineAt = (locator: string, number: number): string => linesOf(locator)[number - 1] ?? ''

const recordAt = (locator: string, number: number): unknown => JSON.parse(lineAt(locator, number))

const blockAt = (locator: string, number: number, index: number): unknown =>
  (recordAt(locator, number) as { message: { content: unknown[] } }).message.content[index]

const makeDirectories =
  (...paths: string[]) =>
  async (home: string): Promise<void> => {
    await Promise.all(paths.map(async (path) => mkdir(join(home, path), { recursive: true })))
  }

const LOCATE_VARIANTS: readonly ILocateVariant[] = [
  {
    name: 'no variable, ~/.claude/projects present',
    arrange: makeDirectories(PROJECTS),
    environment: (home) => environment(home),
    expected: { kind: 'found', root: PROJECTS },
  },
  {
    name: 'CLAUDE_CONFIG_DIR absolute',
    arrange: makeDirectories('config/projects'),
    environment: (home) => environment(home, { [CONFIG_DIR_VARIABLE]: join(home, 'config') }),
    expected: { kind: 'found', root: 'config/projects' },
  },
  {
    name: 'CLAUDE_CONFIG_DIR absolute, with no projects in it',
    arrange: makeDirectories('config'),
    environment: (home) => environment(home, { [CONFIG_DIR_VARIABLE]: join(home, 'config') }),
    expected: { kind: 'not-found', lookedAt: 'config/projects' },
  },
  {
    name: 'CLAUDE_CONFIG_DIR empty',
    arrange: makeDirectories(PROJECTS),
    environment: (home) => environment(home, { [CONFIG_DIR_VARIABLE]: '' }),
    expected: { kind: 'found', root: PROJECTS },
  },
  {
    name: 'CLAUDE_CONFIG_DIR relative, cwd set',
    arrange: makeDirectories('work/shop/claude-config/projects'),
    environment: (home) => environment(home, { [CONFIG_DIR_VARIABLE]: 'claude-config' }, join(home, 'work', 'shop')),
    expected: { kind: 'found', root: 'work/shop/claude-config/projects' },
  },
]

// The committed tree of Claude Code 2.1 transcripts; README.md says what each one exercises.
export const fixtureSet21: IFixtureSet = {
  harnessVersion: '2.1',
  root: ROOT,
  locationKind: 'directory',
  units: [
    { locator: session(BILLING, 3), harnessVersion: '2.1.286', unknownRecords: [] },
    { locator: session(BILLING, 4), harnessVersion: '2.1.286', unknownRecords: [recordAt(session(BILLING, 4), 2)] },
    { locator: session(BILLING, 5), harnessVersion: null, unknownRecords: [] },
    { locator: session(SHOP, 1), harnessVersion: '2.1.286', unknownRecords: [] },
    { locator: session(SHOP, 2), harnessVersion: '2.1.286', unknownRecords: [] },
    { locator: session(SHOP, 6), harnessVersion: '2.2.3', unknownRecords: [] },
    { locator: session(SHOP, 7), harnessVersion: '2.1.286', unknownRecords: [] },
    { locator: session(SHOP, 9), harnessVersion: '2.1.286', unknownRecords: [] },
    { locator: session(SHOP, 10), harnessVersion: '2.1.286', unknownRecords: [] },
    { locator: session(SHOP, 11), harnessVersion: '2.1.286', unknownRecords: [] },
    { locator: session(SHOP, 12), harnessVersion: '2.1.286', unknownRecords: [] },
    {
      locator: session(SHOP, 8),
      harnessVersion: '2.1.286',
      unknownRecords: [
        recordAt(session(SHOP, 8), 1),
        'sdk-ts',
        recordAt(session(SHOP, 8), 62),
        recordAt(session(SHOP, 8), 63),
        recordAt(session(SHOP, 8), 64),
        blockAt(session(SHOP, 8), 65, 1),
        lineAt(session(SHOP, 8), 66),
      ],
    },
  ],
  environment: (home) => environment(home, { [CONFIG_DIR_VARIABLE]: join(home, '.claude') }),
  prepare: async () => Promise.resolve(),
  change: async (home, locator) => {
    const path = join(home, PROJECTS, locator)
    await appendFile(
      path,
      `${JSON.stringify({ type: 'user', uuid: '5f0c2a1e-9999-4000-8000-000000000001', timestamp: '2026-03-02T23:00:00.000Z', message: { role: 'user', content: 'one more thing' } })}\n`
    )
    await utimes(path, CHANGED_AT, CHANGED_AT)
  },
  remove: async (home, locator) => {
    await rm(join(home, PROJECTS, locator))
  },
  locateVariants: LOCATE_VARIANTS,
  neverRead: [
    '.claude/.credentials.json',
    '.claude/settings.json',
    '.claude/skills/review-checklist/SKILL.md',
    `${PROJECTS}/${SHOP}/5f0c2a1e-0000-4000-8000-000000000001/subagents/agent-a1b2c3.meta.json`,
    `${PROJECTS}/${SHOP}/5f0c2a1e-0000-4000-8000-000000000001/tool-results/toolu_example01.txt`,
  ],
}
