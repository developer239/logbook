import { existsSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, inject, it } from 'vitest'
import { useE2eHarness } from './harness.js'

const harness = useE2eHarness()

const OPENCODE_DATABASE = '.local/share/opencode/opencode.db'
const CLAUDE_CODE_PROJECTS = '.claude/projects'

// Every file under a directory, by its path relative to it, sorted.
const filesUnder = async (directory: string): Promise<string[]> =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1))
    .toSorted()

const homeOf = (out: string): string => join(out, 'home')

describe('the demo home', () => {
  it('was built once in UTC while this worker keeps the configured zone', () => {
    // Act
    const demo = inject('e2eDemo')

    // Assert
    expect({
      isBuilt: existsSync(demo.warehouse),
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }).toStrictEqual({ isBuilt: true, zone: 'America/St_Johns' })
  })

  it('provides a plan that names at least one session of each harness', () => {
    // Arrange
    const { plan } = inject('e2eDemo')

    // Act
    const writers = new Set(plan.plan.sessions.map((session) => session.writer))

    // Assert
    expect([...writers].toSorted((left, right) => left - right)).toStrictEqual(
      plan.writers.map((_writer, index) => index)
    )
  })

  it("gives a test a copy of the build's home and no warehouse, or the warehouse when it asks", async () => {
    // Arrange
    const demo = inject('e2eDemo')
    const built = await filesUnder(homeOf(demo.out))

    // Act
    const [plain, synced] = await Promise.all([harness.createHome(), harness.createHome({ isWarehouseCopied: true })])

    // Assert
    expect({
      plain: await filesUnder(homeOf(plain.out)),
      isPlainWarehouse: existsSync(join(plain.out, 'warehouse.db')),
      synced: await filesUnder(homeOf(synced.out)),
      isSyncedWarehouse: existsSync(join(synced.out, 'warehouse.db')),
    }).toStrictEqual({ plain: built, isPlainWarehouse: false, synced: built, isSyncedWarehouse: true })
  })

  it.each([
    ['one-harness', (files: string[]) => files.filter((file) => file !== OPENCODE_DATABASE)],
    ['claude-code-empty', (files: string[]) => files.filter((file) => !file.startsWith(`${CLAUDE_CODE_PROJECTS}/`))],
    ['none', () => []],
  ] as const)('derives the %s home from a fresh copy', async (variant, expected) => {
    // Arrange
    const built = await filesUnder(homeOf(inject('e2eDemo').out))

    // Act
    const home = await harness.createHome({ home: variant })

    // Assert
    expect({
      files: await filesUnder(homeOf(home.out)),
      isProjectsKept: existsSync(join(homeOf(home.out), CLAUDE_CODE_PROJECTS)),
    }).toStrictEqual({ files: expected(built), isProjectsKept: variant !== 'none' })
  })

  it("keeps a file one home's test writes out of every other copy and out of the build", async () => {
    // Arrange
    const [written, other] = await Promise.all([harness.createHome(), harness.createHome()])

    // Act
    await writeFile(join(homeOf(written.out), 'written-by-one-test.txt'), 'mine\n')

    // Assert
    expect({
      isInOther: existsSync(join(homeOf(other.out), 'written-by-one-test.txt')),
      isInBuild: existsSync(join(homeOf(inject('e2eDemo').out), 'written-by-one-test.txt')),
    }).toStrictEqual({ isInOther: false, isInBuild: false })
  })
})
