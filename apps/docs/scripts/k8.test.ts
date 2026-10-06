import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findingLine } from './k7.js'
import { checkK8 } from './k8.js'

const SHOWCASE = '/conversations/claude-code%3Ade30da7a-0000-4000-8000-000000000001'
const DASHBOARD = 'Dashboard\nTool problems\nReactions from the agent\n'
const directories: string[] = []

// A capture of the manifest: a shot's file, the page it was taken on, its scheme and its text.
interface ICapture {
  shot: string
  page: string
  scheme: 'dark' | 'light'
  text: string
}

const both = (shot: string, page: string, text: string): ICapture[] => [
  { shot, page, scheme: 'dark', text },
  { shot, page, scheme: 'light', text },
]

// A temporary repository holding a documentation page and a built site's text captures with the run's manifest.
const linesFor = async (page: string, captures: readonly ICapture[]): Promise<string[]> => {
  const repository = await mkdtemp(join(tmpdir(), 'docs-k8-'))
  directories.push(repository)
  const docs = join(repository, 'apps', 'docs')
  const built = join(docs, '.vitepress', 'dist', 'captures')
  const manifest = {
    captures: captures.map(({ shot, page: path, scheme }) => ({
      file: `${shot}-${scheme}.png`,
      shot,
      scheme,
      page: path,
      text: `${shot}-${scheme}.txt`,
    })),
  }
  const files = {
    [join(docs, 'src', 'using', 'dashboard.md')]: page,
    [join(built, 'manifest.json')]: JSON.stringify(manifest),
    ...Object.fromEntries(captures.map(({ shot, scheme, text }) => [join(built, `${shot}-${scheme}.txt`), text])),
  }
  await Promise.all(
    Object.entries(files).map(async ([file, text]) => {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, text)
    })
  )
  return (await checkK8({ docs, captures: built, repository })).map(findingLine)
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('checkK8', () => {
  it('passes a label in the dark and the light capture of its page', async () => {
    // Act
    const lines = await linesFor(
      'Open <Ui page="/">Reactions from\n  the agent</Ui>.\n',
      both('dashboard', '/?range=30d', DASHBOARD)
    )

    // Assert
    expect(lines).toStrictEqual([])
  })

  it('passes a label the page sets in capitals, as the captured text holds it', async () => {
    // Act
    const lines = await linesFor(
      '<Ui page="/conversations/:id">Session map</Ui>\n',
      both('conversation', SHOWCASE, 'SESSION MAP\nby time\n')
    )

    // Assert
    expect(lines).toStrictEqual([])
  })

  it('fails a label in no capture of its page, naming the docs page, its line, the label and the page', async () => {
    // Act
    const lines = await linesFor(
      '# Dashboard\n\nOpen <Ui page="/">Reactions from the bot</Ui>.\n',
      both('dashboard', '/', DASHBOARD)
    )

    // Assert
    expect(lines).toStrictEqual([
      'K8 apps/docs/src/using/dashboard.md:3 "Reactions from the bot" is in no capture of /',
    ])
  })

  it('fails a label in the dark capture only', async () => {
    // Act
    const lines = await linesFor('<Ui page="/">Reactions from the agent</Ui>\n', [
      { shot: 'dashboard', page: '/', scheme: 'dark', text: DASHBOARD },
      { shot: 'dashboard', page: '/', scheme: 'light', text: 'Dashboard\nTool problems\n' },
    ])

    // Assert
    expect(lines).toStrictEqual([
      'K8 apps/docs/src/using/dashboard.md:1 "Reactions from the agent" is in no light capture of /',
    ])
  })

  it("matches /conversations/:id to the showcase's page and /conversations to the filtered list", async () => {
    // Act
    const lines = await linesFor(
      '<Ui page="/conversations/:id">Session map</Ui> and <Ui page="/conversations">Outcome</Ui>\n',
      [
        ...both('conversation', `${SHOWCASE}?turn=t4`, 'Session map\nTurn 04\n'),
        ...both('conversations-filter', '/conversations?q=outcome%3Adone', 'Conversations\nOutcome\n'),
      ]
    )

    // Assert
    expect(lines).toStrictEqual([])
  })

  it('passes over a <Ui> inside a code block', async () => {
    // Act
    const lines = await linesFor('```md\n<Ui page="/">Not a label</Ui>\n```\n', both('dashboard', '/', DASHBOARD))

    // Assert
    expect(lines).toStrictEqual([])
  })
})
