import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkK6 } from './k6.js'
import { findingLine } from './k7.js'
import type { ICallSite } from './privacy.js'

const STATEMENT = [
  'Log Book runs on your computer.',
  '<!-- data-flow-case: labelling -->',
  'Labelling sends the excerpts in [the table](/labelling/what-it-sends#what-each-request-contains).',
  '<!-- data-flow-case: local -->',
  'Nothing else leaves.',
  '',
].join('\n')
const SUMMARY =
  '<!-- data-flow-case: local -->\n\nLog Book runs on your computer. <!-- data-flow-case: labelling -->Data leaves.\n'
const BUILT_PAGE = '<h2 id="what-each-request-contains">What each request contains</h2>'
const SITES: readonly ICallSite[] = [
  { file: 'packages/engine/src/claude/claude-process.ts', calls: 'starts claude', case: 'labelling' },
  { file: 'apps/cli/src/host-server.ts', calls: 'listens on 127.0.0.1', case: 'local' },
]
const directories: string[] = []

// A temporary repository with a documentation package holding these files.
const siteWith = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const repository = await mkdtemp(join(tmpdir(), 'docs-k6-'))
  directories.push(repository)
  const all = {
    'src/privacy/statement.md': STATEMENT,
    'src/privacy/summary.md': SUMMARY,
    'dist/labelling/what-it-sends.html': BUILT_PAGE,
    ...files,
  }
  await Promise.all(
    Object.entries(all).map(async ([path, text]) => {
      const file = join(repository, 'apps', 'docs', path)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, text)
    })
  )
  return repository
}

const linesOf = async (repository: string, callSites: readonly ICallSite[] = SITES): Promise<string[]> => {
  const docs = join(repository, 'apps', 'docs')
  return (await checkK6({ docs, repository, callSites, built: join(docs, 'dist') })).map(findingLine)
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('checkK6', () => {
  it('passes a statement whose markers match the call sites and whose link reaches its heading', async () => {
    // Arrange
    const repository = await siteWith({})

    // Act
    const lines = await linesOf(repository)

    // Assert
    expect(lines).toStrictEqual([])
  })

  it('refuses a case of the call sites that the statement has no marker for, naming it', async () => {
    // Arrange
    const repository = await siteWith({})

    // Act
    const lines = await linesOf(repository, [
      ...SITES,
      { file: 'packages/engine/src/index.ts', calls: 'example', case: 'telemetry' },
    ])

    // Assert
    expect(lines).toStrictEqual([
      'K6 apps/docs/src/privacy/statement.md:1 the call sites have the case telemetry, which the statement has no marker for',
    ])
  })

  it('refuses a marker in the statement or the summary for a case no call site has', async () => {
    // Arrange
    const statement = `${STATEMENT}<!-- data-flow-case: telemetry -->\nWe count visits.\n`
    const repository = await siteWith({
      'src/privacy/statement.md': statement,
      'src/privacy/summary.md': `${SUMMARY}<!-- data-flow-case: updates -->\n`,
    })

    // Act
    const lines = await linesOf(repository)

    // Assert
    expect(lines).toStrictEqual([
      'K6 apps/docs/src/privacy/statement.md:6 a marker for the case telemetry, which no call site has',
      'K6 apps/docs/src/privacy/summary.md:4 a marker for the case updates, which no call site has',
    ])
  })

  it('refuses a link of the statement to a heading the built page lacks', async () => {
    // Arrange
    const repository = await siteWith({
      'dist/labelling/what-it-sends.html': '<h2 id="what-it-sends">What it sends</h2>',
    })

    // Act
    const lines = await linesOf(repository)

    // Assert
    expect(lines).toStrictEqual([
      'K6 apps/docs/src/privacy/statement.md:3 the link to /labelling/what-it-sends#what-each-request-contains reaches no such heading in the built site',
    ])
  })
})
