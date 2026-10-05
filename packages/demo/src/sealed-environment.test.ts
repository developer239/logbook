import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { sealedEnvironment } from './sealed-environment.js'

const SEALED = {
  HOME: '/tmp/logbook-example/home',
  LOGBOOK_DB: '/tmp/logbook-example/warehouse.db',
  PATH: '/usr/bin:/bin',
  TZ: 'UTC',
  LANG: 'C.UTF-8',
}

describe('sealedEnvironment', () => {
  it('holds exactly the five variables', () => {
    // Arrange
    const out = '/tmp/logbook-example'

    // Act
    const environment = sealedEnvironment(out)

    // Assert
    expect(environment).toStrictEqual(SEALED)
  })

  it('passes none of the calling process variables through', () => {
    // Arrange
    for (const name of ['CLAUDE_CONFIG_DIR', 'OPENCODE_DB', 'XDG_DATA_HOME', 'CLAUDE_BIN', 'ANTHROPIC_API_KEY']) {
      vi.stubEnv(name, '/srv/real-data')
    }

    // Act
    const environment = sealedEnvironment('/tmp/logbook-example')

    // Assert
    expect(environment).toStrictEqual(SEALED)
  })

  it('resolves a relative out against the working directory', () => {
    // Arrange
    const out = 'out/small'

    // Act
    const environment = sealedEnvironment(out)

    // Assert
    expect([environment.HOME, environment.LOGBOOK_DB]).toStrictEqual([
      join(process.cwd(), 'out', 'small', 'home'),
      join(process.cwd(), 'out', 'small', 'warehouse.db'),
    ])
  })

  it('returns a new object on every call', () => {
    // Arrange
    const first = sealedEnvironment('/tmp/logbook-example')

    // Act
    first.EXTRA = 'added'
    const second = sealedEnvironment('/tmp/logbook-example')

    // Assert
    expect(second).toStrictEqual(SEALED)
  })
})
