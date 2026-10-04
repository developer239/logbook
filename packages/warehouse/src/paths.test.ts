import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDataDirectory, resolveWarehousePath } from './paths.js'

const HOME = '/home/example'
const DEFAULT_DIRECTORY = '/home/example/.local/share/log-book'

describe('resolveWarehousePath', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', HOME)
    vi.stubEnv('LOGBOOK_DB', undefined)
    vi.stubEnv('XDG_DATA_HOME', undefined)
  })

  it('takes an absolute LOGBOOK_DB over XDG_DATA_HOME', () => {
    // Arrange
    vi.stubEnv('LOGBOOK_DB', '/srv/logs/warehouse.db')
    vi.stubEnv('XDG_DATA_HOME', '/srv/xdg')

    // Act
    const path = resolveWarehousePath()

    // Assert
    expect(path).toBe('/srv/logs/warehouse.db')
  })

  it('refuses a relative LOGBOOK_DB with WAREHOUSE_PATH_INVALID, naming the variable', () => {
    // Arrange
    vi.stubEnv('LOGBOOK_DB', 'warehouse.db')

    // Act
    const resolving = resolveWarehousePath

    // Assert
    expect(resolving).toThrow(
      expect.objectContaining({
        name: 'LogBookError',
        code: 'WAREHOUSE_PATH_INVALID',
        message: 'LOGBOOK_DB must be an absolute path to the warehouse file; it is "warehouse.db".',
      })
    )
  })

  it('treats an empty LOGBOOK_DB as unset', () => {
    // Arrange
    vi.stubEnv('LOGBOOK_DB', '')

    // Act
    const path = resolveWarehousePath()

    // Assert
    expect(path).toBe(`${DEFAULT_DIRECTORY}/warehouse.db`)
  })

  it('puts the warehouse under an absolute XDG_DATA_HOME', () => {
    // Arrange
    vi.stubEnv('XDG_DATA_HOME', '/srv/xdg')

    // Act
    const path = resolveWarehousePath()

    // Assert
    expect(path).toBe('/srv/xdg/log-book/warehouse.db')
  })

  it.each(['relative/data', ''])('ignores XDG_DATA_HOME "%s" and uses the home directory', (xdgDataHome) => {
    // Arrange
    vi.stubEnv('XDG_DATA_HOME', xdgDataHome)

    // Act
    const path = resolveWarehousePath()

    // Assert
    expect(path).toBe(`${DEFAULT_DIRECTORY}/warehouse.db`)
  })
})

describe('resolveDataDirectory', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', HOME)
    vi.stubEnv('LOGBOOK_DB', '/srv/logs/warehouse.db')
    vi.stubEnv('XDG_DATA_HOME', undefined)
  })

  it('ignores LOGBOOK_DB and follows the XDG_DATA_HOME rule', () => {
    // Arrange
    const results: string[] = []

    // Act
    results.push(resolveDataDirectory())
    vi.stubEnv('XDG_DATA_HOME', '/srv/xdg')
    results.push(resolveDataDirectory())
    vi.stubEnv('XDG_DATA_HOME', 'relative/data')
    results.push(resolveDataDirectory())

    // Assert
    expect(results).toStrictEqual([DEFAULT_DIRECTORY, '/srv/xdg/log-book', DEFAULT_DIRECTORY])
  })
})
