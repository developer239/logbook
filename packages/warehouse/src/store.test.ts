import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openSqlite, runSubprocess } from '@log-book/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WarehouseStore } from './store.js'

const CHILD_TIMEOUT_MS = 10_000

// The permission bits, the low nine bits of the mode.
const modeOf = (path: string): number => statSync(path).mode % 0o1000

// Builds a warehouse file at `version` with nothing in it but the version.
const writeVersionedFile = async (path: string, version: number): Promise<void> => {
  const db = await openSqlite(path, { isReadOnly: false })
  db.exec(`PRAGMA user_version = ${String(version)}`)
  db.close()
}

// Lets a child process import the TypeScript sources: Node strips the types, and this maps an import of `./x.js` to
// `./x.ts` when no `./x.js` exists.
const RESOLVE_TYPESCRIPT_HOOK = `export const resolve = async (specifier, context, nextResolve) => {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context)
    }
    throw error
  }
}
`

// Signals ready, waits for the go file, then opens the warehouse once.
const RACING_CHILD = `import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
const [storeUrl, warehousePath, readyFile, goFile] = process.argv.slice(2)
const { WarehouseStore } = await import(storeUrl)
writeFileSync(readyFile, '')
while (!existsSync(goFile)) {
  await delay(5)
}
const store = await WarehouseStore.open(warehousePath)
store.close()
`

describe('WarehouseStore', () => {
  let directory = ''
  let dataDirectory = ''

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-store-')))
    vi.stubEnv('XDG_DATA_HOME', join(directory, 'data'))
    vi.stubEnv('LOGBOOK_DB', undefined)
    dataDirectory = join(directory, 'data', 'log-book')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  describe('open', () => {
    it('creates a new warehouse with a 0700 directory and 0600 files', async () => {
      // Arrange
      const path = join(dataDirectory, 'warehouse.db')

      // Act
      const store = await WarehouseStore.open(path)
      const modes = [dataDirectory, path, `${path}-wal`, `${path}-shm`].map(modeOf)
      store.close()

      // Assert
      expect(modes).toStrictEqual([0o700, 0o600, 0o600, 0o600])
    })

    it('tightens a loosened directory and files inside the data directory', async () => {
      // Arrange
      const path = join(dataDirectory, 'warehouse.db')
      ;(await WarehouseStore.open(path)).close()
      chmodSync(dataDirectory, 0o755)
      chmodSync(path, 0o644)

      // Act
      const store = await WarehouseStore.open(path)
      const modes = [dataDirectory, path, `${path}-wal`, `${path}-shm`].map(modeOf)
      store.close()

      // Assert
      expect(modes).toStrictEqual([0o700, 0o600, 0o600, 0o600])
    })

    it('keeps the mode of an existing directory outside the data directory and tightens the files', async () => {
      // Arrange
      const userDirectory = join(directory, 'elsewhere')
      mkdirSync(userDirectory)
      chmodSync(userDirectory, 0o755)
      const path = join(userDirectory, 'warehouse.db')

      // Act
      const store = await WarehouseStore.open(path)
      const modes = [userDirectory, path, `${path}-wal`, `${path}-shm`].map(modeOf)
      store.close()

      // Assert
      expect(modes).toStrictEqual([0o755, 0o600, 0o600, 0o600])
    })

    it('sets the write-ahead log and its size limit', async () => {
      // Arrange
      const store = await WarehouseStore.open(join(dataDirectory, 'warehouse.db'))

      // Act
      const pragmas = [store.get('PRAGMA journal_mode'), store.get('PRAGMA journal_size_limit')]
      store.close()

      // Assert
      expect(pragmas).toStrictEqual([{ journal_mode: 'wal' }, { journal_size_limit: 67_108_864 }])
    })

    it('creates a missing warehouse at the newest version', async () => {
      // Arrange
      const path = join(dataDirectory, 'nested', 'warehouse.db')

      // Act
      const store = await WarehouseStore.open(path)
      const result = {
        previousVersion: store.previousVersion,
        version: store.version,
        userVersion: store.get('PRAGMA user_version'),
      }
      store.close()

      // Assert
      expect(result).toStrictEqual({ previousVersion: 0, version: 1, userVersion: { user_version: 1 } })
    })

    it('migrates an older warehouse and reports both versions', async () => {
      // Arrange
      mkdirSync(dataDirectory, { recursive: true })
      const path = join(dataDirectory, 'warehouse.db')
      await writeVersionedFile(path, 0)

      // Act
      const store = await WarehouseStore.open(path)
      const result = { previousVersion: store.previousVersion, version: store.version }
      store.close()

      // Assert
      expect(result).toStrictEqual({ previousVersion: 0, version: 1 })
    })

    it('opens a warehouse at the newest version', async () => {
      // Arrange
      const path = join(dataDirectory, 'warehouse.db')
      ;(await WarehouseStore.open(path)).close()

      // Act
      const store = await WarehouseStore.open(path)
      const result = { previousVersion: store.previousVersion, version: store.version }
      store.close()

      // Assert
      expect(result).toStrictEqual({ previousVersion: 1, version: 1 })
    })

    it('refuses a newer warehouse with both versions and leaves its bytes unchanged', async () => {
      // Arrange
      mkdirSync(dataDirectory, { recursive: true })
      const path = join(dataDirectory, 'warehouse.db')
      await writeVersionedFile(path, 2)
      const before = await readFile(path)

      // Act
      const opening = WarehouseStore.open(path)

      // Assert
      await expect(opening).rejects.toThrow(
        expect.objectContaining({ code: 'WAREHOUSE_SCHEMA_NEWER', warehouseVersion: 2, buildVersion: 1 })
      )
      expect((await readFile(path)).equals(before)).toBe(true)
    })

    it('applies a missing step once when two processes open the same old warehouse at once', async () => {
      // Arrange
      mkdirSync(dataDirectory, { recursive: true })
      const path = join(dataDirectory, 'warehouse.db')
      await writeVersionedFile(path, 0)
      const hook = join(directory, 'hook.mjs')
      const register = join(directory, 'register.mjs')
      const child = join(directory, 'child.mjs')
      const goFile = join(directory, 'go')
      await writeFile(hook, RESOLVE_TYPESCRIPT_HOOK)
      await writeFile(
        register,
        `import { register } from 'node:module'\nregister(${JSON.stringify(pathToFileURL(hook).href)})\n`
      )
      await writeFile(child, RACING_CHILD)
      const storeUrl = new URL('./store.ts', import.meta.url).href
      const readyFiles = [join(directory, 'ready-1'), join(directory, 'ready-2')]
      const children = readyFiles.map((readyFile) =>
        runSubprocess({
          command: process.execPath,
          args: ['--import', register, child, storeUrl, path, readyFile, goFile],
          timeoutMs: CHILD_TIMEOUT_MS,
          label: 'node',
        })
      )
      await vi.waitFor(() => expect(readyFiles.map((file) => existsSync(file))).toStrictEqual([true, true]), {
        timeout: CHILD_TIMEOUT_MS,
      })

      // Act
      await writeFile(goFile, '')
      const results = await Promise.all(children)

      // Assert
      expect(results.map(({ exitCode, stderr }) => ({ exitCode, stderr }))).toStrictEqual([
        { exitCode: 0, stderr: '' },
        { exitCode: 0, stderr: '' },
      ])
      const db = await openSqlite(path, { isReadOnly: true })
      expect(db.prepare('PRAGMA user_version').get()).toStrictEqual(
        Object.assign(Object.create(null) as object, { user_version: 1 })
      )
      db.close()
    })
  })

  describe('openReadOnly', () => {
    it('refuses a missing warehouse and creates nothing', async () => {
      // Arrange
      const missingDirectory = join(directory, 'missing')
      const path = join(missingDirectory, 'warehouse.db')

      // Act
      const opening = WarehouseStore.openReadOnly(path)

      // Assert
      await expect(opening).rejects.toThrow(
        expect.objectContaining({ code: 'WAREHOUSE_NOT_FOUND', message: `No warehouse at ${path}.` })
      )
      expect(existsSync(missingDirectory)).toBe(false)
    })

    it.each([
      { state: 'older', version: 0 },
      { state: 'newer', version: 2 },
    ])('refuses an $state warehouse with both versions', async ({ version }) => {
      // Arrange
      mkdirSync(dataDirectory, { recursive: true })
      const path = join(dataDirectory, 'warehouse.db')
      await writeVersionedFile(path, version)

      // Act
      const opening = WarehouseStore.openReadOnly(path)

      // Assert
      await expect(opening).rejects.toThrow(
        expect.objectContaining({ code: 'WAREHOUSE_SCHEMA_MISMATCH', warehouseVersion: version, buildVersion: 1 })
      )
    })

    it('opens a warehouse at the newest version and reads it', async () => {
      // Arrange
      const path = join(dataDirectory, 'warehouse.db')
      ;(await WarehouseStore.open(path)).close()

      // Act
      const reader = await WarehouseStore.openReadOnly(path)
      const result = { version: reader.get('PRAGMA user_version'), sessions: reader.all('SELECT id FROM session') }
      reader.close()

      // Assert
      expect(result).toStrictEqual({ version: { user_version: 1 }, sessions: [] })
    })
  })
})
