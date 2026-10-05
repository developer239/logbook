import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { trackedFiles } from '../tracked-files.js'

interface IFixtureRule {
  name: string
  // What the rule looks at in a line.
  found: RegExp
  isAllowed: (text: string) => boolean
}

const FIXTURES = /^packages\/adapter-[^/]+\/fixtures\//u
const EXAMPLE_HOME = '/home/example'
// An id's letters and digits after its prefix, holding at least one digit: every id has one, while words such as
// `agent-switched` and a template's `ses_example${n}` have none.
const ID_TOKEN = String.raw`(?=[A-Za-z]*\d)[A-Za-z0-9]+`

// Adapter fixtures are invented in one recognisable shape, so a real path or id stands out among them.
const FIXTURE_RULES: readonly IFixtureRule[] = [
  {
    name: 'fixture-home',
    found: /\/(?:Users|home|root)\/[^\s"'`,)}\]]*/gu,
    isAllowed: (path) => path === EXAMPLE_HOME || path.startsWith(`${EXAMPLE_HOME}/`),
  },
  {
    name: 'fixture-id',
    found: new RegExp(String.raw`\b(?:ses|msg|prt|toolu|req)_${ID_TOKEN}`, 'gu'),
    isAllowed: (id) => /^[a-z]+_(?:example|demo)\d+$/u.test(id),
  },
  {
    name: 'fixture-uuid',
    found: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
    isAllowed: (uuid) => uuid.startsWith('5f0c2a1e-') || uuid.startsWith('de30da7a-'),
  },
  {
    name: 'fixture-agent',
    found: new RegExp(String.raw`\bagent-${ID_TOKEN}`, 'gu'),
    isAllowed: (agent) => /^agent-(?:example|demo)\d+$/u.test(agent),
  },
]

const lineFindings = (file: string, line: string, number: number): string[] =>
  FIXTURE_RULES.flatMap((rule) =>
    [...line.matchAll(rule.found)]
      .map((match) => match[0])
      .filter((text) => !rule.isAllowed(text))
      .map((text) => `${file}:${String(number)}: ${text} is not an invented value [${rule.name}]`)
  )

// Every value in an adapter fixture that is not in its invented shape, with its file, line and rule.
export const fixtureFindings = async (root: string): Promise<string[]> => {
  const files = (await trackedFiles(root, ['packages'])).filter((file) => FIXTURES.test(file))
  const findings = await Promise.all(
    files.map(async (file) =>
      (await readFile(join(root, file), 'utf8'))
        .split('\n')
        .flatMap((line, index) => lineFindings(file, line, index + 1))
    )
  )
  return findings.flat()
}
