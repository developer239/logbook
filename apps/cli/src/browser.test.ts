import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BROWSER_URL, findOnPath, openBrowser, openerName } from './browser.js'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ALLOWLIST = join(REPOSITORY_ROOT, 'packages/engine/network-call-sites.json')
const URL_SHOWN = 'http://127.0.0.1:7314'
const EXECUTABLE = 0o755
const PLAIN = 0o644

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cli-browser-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

// A stand-in opener in its own directory: it records its arguments and exits with the given code.
const opener = async (name: string, code: number): Promise<{ bin: string; recorded: string }> => {
  const bin = join(directory, 'bin')
  const recorded = join(directory, 'opened.txt')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, name), `#!/bin/sh\necho "$@" >> '${recorded}'\nexit ${String(code)}\n`)
  await chmod(join(bin, name), EXECUTABLE)
  return { bin, recorded }
}

describe('openerName', () => {
  it('is open on macOS and xdg-open on Linux', () => {
    // Act
    const names = [openerName('darwin'), openerName('linux')]

    // Assert
    expect(names).toStrictEqual(['open', 'xdg-open'])
  })
})

describe('findOnPath', () => {
  it.each(['open', 'xdg-open'])(
    'finds the first executable %s on PATH, past a plain file and a directory',
    async (name) => {
      // Arrange
      const plain = join(directory, 'plain')
      const folder = join(directory, 'folder')
      const found = join(directory, 'found')
      await Promise.all([plain, join(folder, name), found].map(async (path) => mkdir(path, { recursive: true })))
      await writeFile(join(plain, name), '')
      await chmod(join(plain, name), PLAIN)
      await writeFile(join(found, name), '#!/bin/sh\n')
      await chmod(join(found, name), EXECUTABLE)

      // Act
      const path = findOnPath(name, ['', plain, folder, found].join(delimiter))

      // Assert
      expect(path).toBe(join(found, name))
    }
  )

  it('finds nothing on an empty or missing PATH', () => {
    // Act
    const found = [findOnPath('xdg-open', ''), findOnPath('xdg-open', undefined)]

    // Assert
    expect(found).toStrictEqual([null, null])
  })
})

describe('openBrowser', () => {
  it('starts the opener with the URL and prints nothing when it succeeds', async () => {
    // Arrange
    const { bin, recorded } = await opener('xdg-open', 0)
    const lines: string[] = []

    // Act
    const child = openBrowser(URL_SHOWN, (text) => lines.push(text), { platform: 'linux', path: bin })
    if (child !== null) {
      await once(child, 'exit')
    }

    // Assert
    expect({ lines, recorded: await readFile(recorded, 'utf8') }).toStrictEqual({
      lines: [],
      recorded: `${URL_SHOWN}\n`,
    })
  })

  it('says it did not open the page when the opener exits with another code than 0', async () => {
    // Arrange
    const { bin } = await opener('open', 3)
    const lines: string[] = []

    // Act
    const child = openBrowser(URL_SHOWN, (text) => lines.push(text), { platform: 'darwin', path: bin })
    if (child !== null) {
      await once(child, 'exit')
    }

    // Assert
    expect(lines).toStrictEqual([
      'Browser      not opened: open exited with code 3. Open http://127.0.0.1:7314 yourself, or start with logbook --no-open.',
    ])
  })

  it('says there is no opener when PATH has none, and starts nothing', () => {
    // Arrange
    const lines: string[] = []

    // Act
    const child = openBrowser(URL_SHOWN, (text) => lines.push(text), { platform: 'linux', path: directory })

    // Assert
    expect({ child, lines }).toStrictEqual({
      child: null,
      lines: [
        'Browser      not opened: no xdg-open on this machine. Open http://127.0.0.1:7314 yourself, or start with logbook --no-open.',
      ],
    })
  })
})

describe('the network allowlist', () => {
  it('lists the opener as a local call site, at the path this module has', async () => {
    // Arrange
    const sites = JSON.parse(await readFile(ALLOWLIST, 'utf8')) as { file: string; case: string }[]
    const file = relative(REPOSITORY_ROOT, fileURLToPath(BROWSER_URL))

    // Act
    const entries = sites.filter((site) => site.file === file).map((site) => site.case)

    // Assert
    expect(entries).toStrictEqual(['local'])
  })
})
