import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { writeHome } from '../build/build-demo.js'
import type * as Planner from '../plan/planner.js'
import { planDataset } from '../plan/planner.js'
import { scanText } from './scan-text.js'

vi.mock('../plan/planner.js', async (importOriginal) => {
  const original = await importOriginal<typeof Planner>()
  return { ...original, planDataset: vi.fn(original.planDataset) }
})

const SMALL = { size: 'small', seed: 1 } as const

// One session id and one tool call id the writers give the small set.
const smallIds = async (): Promise<{ session: string; toolCall: string }> => {
  const directory = await mkdtemp(join(tmpdir(), 'scan-ids-'))
  try {
    const { expected } = await writeHome(directory, { size: 'small' })
    const withCall = expected.find((imported) => imported.toolCalls.length > 0)
    if (withCall === undefined) {
      throw new Error('The small set writes no tool call')
    }
    return { session: withCall.session.id, toolCall: withCall.toolCalls[0]?.id ?? '' }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('scanText', () => {
  it("passes text naming one of the small set's session ids and one of its tool call ids", async () => {
    // Arrange
    const { session, toolCall } = await smallIds()

    // Act
    const findings = await scanText(`Reproduce on /conversations/${session}\nThe call ${toolCall} failed.\n`, SMALL)

    // Assert
    expect(findings).toStrictEqual([])
  })

  it.each([
    ['a UUID whose first group is not de30da7a', 'See de30da7b-0000-4000-8000-000000000001', 'C5'],
    ['a ses_ token outside ses_demo<n>', 'opencode:ses_abc1', 'C5'],
    ['an id the small set does not generate', 'opencode:ses_demo9999', 'ids'],
  ])('fails %s', async (_name, line, rule) => {
    // Act
    const findings = await scanText(`A first line\n${line}\n`, SMALL)

    // Assert
    expect(findings).toStrictEqual([{ rule, line: 2 }])
  })

  it("fails the scanning machine's home directory with C4, holding the line's number and not the path", async () => {
    // Act
    const findings = await scanText(`A first line\nSaved under ${homedir()}\n`, SMALL)

    // Assert
    expect({
      c4: findings.filter((found) => found.rule === 'C4'),
      leaks: findings.filter((found) => JSON.stringify(found).includes(homedir())),
    }).toStrictEqual({ c4: [{ rule: 'C4', line: 2 }], leaks: [] })
  })

  it('plans a size and seed once for the life of the process', async () => {
    // Arrange
    const other = { size: 'small', seed: 2 } as const
    const before = vi.mocked(planDataset).mock.calls.length

    // Act
    await scanText('opencode:ses_demo1', other)
    await scanText('opencode:ses_demo2', other)

    // Assert
    expect(vi.mocked(planDataset).mock.calls.length - before).toBe(1)
  })
})
