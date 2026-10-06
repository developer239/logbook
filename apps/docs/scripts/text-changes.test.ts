import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runTextChanges, textChangesReport } from './text-changes.js'

const HEADING = '### Shots whose text changed against main\n\n'
const DASHBOARD = 'Dashboard\nReactions from the agent\nLast 7 days\nTue, Oct 6, 14:00 · 173 prompts\nCorrections 3%\n'
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('textChangesReport', () => {
  it('reports nothing for two sets that differ only in digits and in month and weekday names', () => {
    // Arrange
    const baseline = {
      'dashboard-dark.txt': DASHBOARD.replace('Tue, Oct 6, 14:00 · 173', 'Wednesday, September 30, 9:00 · 2'),
      'tour-1.txt': 'Time per turn\n4.4 min over 7.3 min\n',
    }

    // Act
    const report = textChangesReport(
      { 'dashboard-dark.txt': DASHBOARD, 'tour-1.txt': 'Time per turn\n12.1 min over 3.0 min\n' },
      baseline
    )

    // Assert
    expect(report).toBe(`${HEADING}No shot's or video's text changed.\n`)
  })

  it('reports a shot whose heading changed in one scheme, and a capture present on one side only', () => {
    // Act
    const report = textChangesReport(
      {
        'dashboard-dark.txt': DASHBOARD,
        'dashboard-light.txt': DASHBOARD.replace('Reactions from the agent', 'Replies from the agent'),
        'conversation-scroll-1.txt': 'Turn 01\n',
      },
      { 'dashboard-dark.txt': DASHBOARD, 'dashboard-light.txt': DASHBOARD }
    )

    // Assert
    expect(report).toBe(
      `${HEADING}- \`conversation-scroll\`: 1 line added, 0 lines removed\n` +
        '- `dashboard`: 1 line added, 1 line removed\n'
    )
  })

  it('reports nothing for equal lines in another order', () => {
    // Act
    const report = textChangesReport(
      { 'tokens-dark.txt': 'Tokens by tool\nRead\nEdit\n' },
      { 'tokens-dark.txt': 'Tokens by tool\nEdit\nRead\n' }
    )

    // Assert
    expect(report).toBe(`${HEADING}No shot's or video's text changed.\n`)
  })
})

describe('runTextChanges', () => {
  it('prints the no-baseline line and exits 0 when the baseline directory does not exist', async () => {
    // Arrange
    const captures = await mkdtemp(join(tmpdir(), 'docs-text-changes-'))
    directories.push(captures)
    await writeFile(join(captures, 'dashboard-dark.txt'), DASHBOARD)
    const written: string[] = []

    // Act
    const code = await runTextChanges(
      ['--baseline', join(captures, 'missing')],
      (text) => {
        written.push(text)
      },
      captures
    )

    // Assert
    expect({ code, written }).toStrictEqual({
      code: 0,
      written: [`${HEADING}There is no baseline of text captures to compare with, so no shot is listed.\n`],
    })
  })
})
