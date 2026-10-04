import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listTranscriptSets } from './listing.js'

const LINE = '{"type":"user"}\n'

const transcript = async (path: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, LINE)
}

describe('listTranscriptSets', () => {
  let projects = ''
  let outside = ''
  const { signal } = new AbortController()

  const summary = async (): Promise<{ locator: string; subagents: string[] }[]> =>
    (await listTranscriptSets(projects, signal)).map((set) => ({
      locator: set.locator,
      subagents: set.subagentPaths.map((path) => path.slice(projects.length + 1)),
    }))

  beforeEach(async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'log-book-claude-listing-')))
    projects = join(root, 'projects')
    outside = join(root, 'outside')
    await mkdir(projects)
    await mkdir(outside)
  })

  afterEach(async () => {
    await rm(join(projects, '..'), { recursive: true, force: true })
  })

  it('lists one unit per session with its subagents sorted by name, and nothing deeper', async () => {
    // Arrange
    await transcript(join(projects, 'project-b', 'session-2.jsonl'))
    await transcript(join(projects, 'project-a', 'session-1.jsonl'))
    await transcript(join(projects, 'project-a', 'session-1', 'subagents', 'agent-b.jsonl'))
    await transcript(join(projects, 'project-a', 'session-1', 'subagents', 'agent-a.jsonl'))
    await transcript(join(projects, 'project-a', 'session-1', 'subagents', 'deeper', 'agent-c.jsonl'))
    await transcript(join(projects, 'project-a', 'orphan', 'subagents', 'agent-d.jsonl'))
    await writeFile(join(projects, 'project-a', 'session-1.meta.json'), '{}')

    // Act
    const units = await summary()

    // Assert
    expect(units).toStrictEqual([
      {
        locator: 'project-a/session-1.jsonl',
        subagents: ['project-a/session-1/subagents/agent-a.jsonl', 'project-a/session-1/subagents/agent-b.jsonl'],
      },
      { locator: 'project-b/session-2.jsonl', subagents: [] },
    ])
  })

  it('skips a symbolic link at each of the four levels', async () => {
    // Arrange
    await transcript(join(projects, 'project-a', 'session-1.jsonl'))
    await transcript(join(outside, 'project', 'session-9.jsonl'))
    await transcript(join(outside, 'session-8.jsonl'))
    await transcript(join(outside, 'subagents', 'agent-x.jsonl'))
    await transcript(join(outside, 'agent-y.jsonl'))
    await symlink(join(outside, 'project'), join(projects, 'linked-project'))
    await symlink(join(outside, 'session-8.jsonl'), join(projects, 'project-a', 'session-8.jsonl'))
    await transcript(join(projects, 'project-a', 'session-2.jsonl'))
    // Followed, this link would give session-2 the subagent outside/subagents/agent-x.jsonl.
    await symlink(outside, join(projects, 'project-a', 'session-2'), 'dir')
    await mkdir(join(projects, 'project-a', 'session-1', 'subagents'), { recursive: true })
    await symlink(
      join(outside, 'agent-y.jsonl'),
      join(projects, 'project-a', 'session-1', 'subagents', 'agent-y.jsonl')
    )
    await mkdir(join(projects, 'project-a', 'session-3'), { recursive: true })
    await transcript(join(projects, 'project-a', 'session-3.jsonl'))
    await symlink(join(outside, 'subagents'), join(projects, 'project-a', 'session-3', 'subagents'))

    // Act
    const units = await summary()

    // Assert
    expect(units).toStrictEqual([
      { locator: 'project-a/session-1.jsonl', subagents: [] },
      { locator: 'project-a/session-2.jsonl', subagents: [] },
      { locator: 'project-a/session-3.jsonl', subagents: [] },
    ])
  })

  it('changes the fingerprint when a file grows or a subagent file is added, and only then', async () => {
    // Arrange
    const main = join(projects, 'project-a', 'session-1.jsonl')
    await transcript(main)
    const fingerprint = async (): Promise<string | undefined> =>
      (await listTranscriptSets(projects, signal))[0]?.fingerprint
    const first = await fingerprint()
    const unchanged = await fingerprint()

    // Act
    await appendFile(main, LINE)
    const grown = await fingerprint()
    await transcript(join(projects, 'project-a', 'session-1', 'subagents', 'agent-a.jsonl'))
    const withSubagent = await fingerprint()

    // Assert
    expect({
      isUnchangedEqual: unchanged === first,
      isGrownDifferent: grown !== unchanged,
      isSubagentDifferent: withSubagent !== grown,
      shape: withSubagent?.split(',').map((part) => /^\d+@\d+$/u.test(part)),
    }).toStrictEqual({ isUnchangedEqual: true, isGrownDifferent: true, isSubagentDifferent: true, shape: [true, true] })
  })

  it('throws the reason of an aborted signal', async () => {
    // Arrange
    await transcript(join(projects, 'project-a', 'session-1.jsonl'))
    const controller = new AbortController()
    const reason = new Error('stopped by a signal')
    controller.abort(reason)

    // Act
    const listing = listTranscriptSets(projects, controller.signal)

    // Assert
    await expect(listing).rejects.toBe(reason)
  })
})
