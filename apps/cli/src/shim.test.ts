import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface IShimRun {
  code: number
  stdout: string
  stderr: string
}

const SHIM = fileURLToPath(new URL('../bin/logbook.cjs', import.meta.url))
const MANIFEST = fileURLToPath(new URL('../package.json', import.meta.url))

const runShim = async (shim: string, args: readonly string[], nodeArgs: readonly string[] = []): Promise<IShimRun> =>
  new Promise((resolve) => {
    execFile(process.execPath, [...nodeArgs, shim, ...args], (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr })
    })
  })

const withDirectory = async <TResult>(use: (directory: string) => Promise<TResult>): Promise<TResult> => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-shim-'))
  try {
    return await use(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('the logbook shim', () => {
  it('exits 5 with the WSL line on a platform other than macOS and Linux', async () => {
    // Act
    const result = await withDirectory(async (directory) => {
      const windows = join(directory, 'windows.cjs')
      await writeFile(windows, "Object.defineProperty(process, 'platform', { value: 'win32' })\n")
      return runShim(SHIM, ['--version'], ['--require', windows])
    })

    // Assert
    expect(result).toStrictEqual({
      code: 5,
      stdout: '',
      stderr: 'Log Book runs on macOS and Linux. On Windows, run it inside WSL, where your agents run.\n',
    })
  })

  it('exits 5 below a raised floor, naming it twice, with nothing on stdout', async () => {
    // Act
    const result = await withDirectory(async (directory) => {
      await mkdir(join(directory, 'bin'))
      const shim = join(directory, 'bin', 'logbook.cjs')
      await copyFile(SHIM, shim)
      await writeFile(join(directory, 'package.json'), JSON.stringify({ engines: { node: '>=24.99' } }))
      return runShim(shim, ['--version'])
    })

    // Assert
    expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toStrictEqual({
      code: 5,
      stdout: '',
      stderr:
        `Log Book needs Node.js 24.99 or newer; this is Node.js ${process.versions.node} at ${process.execPath}. ` +
        'Install Node.js 24.99 (https://nodejs.org) or switch to it with your version manager, then run logbook again.\n',
    })
  })

  it('reaches the entry on this Node with the real floor, which prints the version', async () => {
    // Arrange
    const { version } = JSON.parse(await readFile(MANIFEST, 'utf8')) as { version: string }

    // Act
    const result = await runShim(SHIM, ['--version'])

    // Assert
    expect(result).toStrictEqual({ code: 0, stdout: `${version}\n`, stderr: '' })
  })
})
