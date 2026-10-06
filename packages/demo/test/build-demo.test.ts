import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, inject, it, vi } from 'vitest'
import { buildDemo } from '../src/build/build-demo.js'
import { DEMO_ERROR_CODES } from '../src/errors.js'

const directories: string[] = []

const temporary = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'demo-build-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('buildDemo', () => {
  it('leaves the home, the plan file, the manifest and the warehouse, and returns the plan it wrote', async () => {
    // Arrange
    const small = inject('smallDemo')

    // Act
    const [entries, planFile] = await Promise.all([readdir(small.out), readFile(join(small.out, 'plan.json'), 'utf8')])

    // Assert
    expect({
      entries: ['home', 'manifest.json', 'plan.json', 'warehouse.db'].filter((entry) => entries.includes(entry)),
      warehouse: small.warehouse,
      plan: JSON.parse(planFile) as unknown,
    }).toStrictEqual({
      entries: ['home', 'manifest.json', 'plan.json', 'warehouse.db'],
      warehouse: join(small.out, 'warehouse.db'),
      plan: small.plan,
    })
  })

  it('refuses an out directory that holds anything but a demo build, and leaves it as it was', async () => {
    // Arrange
    vi.stubEnv('TZ', 'UTC')
    const out = await temporary()
    await writeFile(join(out, 'notes.txt'), 'mine')

    // Act
    const building = buildDemo({ size: 'small', out })

    // Assert
    await expect(building).rejects.toMatchObject({
      code: DEMO_ERROR_CODES.DEMO_OUT_NOT_DEMO,
      message: `${out} holds something other than a demo build; give an empty or new directory`,
    })
    expect(await readdir(out)).toStrictEqual(['notes.txt'])
  })

  it("builds again into a previous build's directory, replacing what it held", async () => {
    // Arrange
    vi.stubEnv('TZ', 'UTC')
    const out = join(await temporary(), 'small')
    await cp(inject('smallDemo').out, out, { recursive: true })
    await writeFile(join(out, 'home', 'left-over.txt'), 'from the last build')

    // Act
    const built = await buildDemo({ size: 'small', out })

    // Assert
    expect({
      manifest: built.manifest,
      homeEntries: (await readdir(join(out, 'home'))).includes('left-over.txt'),
    }).toStrictEqual({
      manifest: inject('smallDemo').manifest,
      homeEntries: false,
    })
  })
})
