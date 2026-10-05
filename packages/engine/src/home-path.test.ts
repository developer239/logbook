import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { adapterEnvironment, withHomeAsTilde } from './home-path.js'

// An invented home.
const HOME = '/home/ana'

describe('withHomeAsTilde', () => {
  it.each([
    ['a path under the home', '/home/ana/.local/share/opencode/opencode.db', '~/.local/share/opencode/opencode.db'],
    [
      'two occurrences in one message',
      'cannot read /home/ana/.local/share/opencode/opencode.db: EACCES, tried /home/ana/work/db',
      'cannot read ~/.local/share/opencode/opencode.db: EACCES, tried ~/work/db',
    ],
    ['the home directory alone', 'looked in /home/ana', 'looked in /home/ana'],
    ['a sibling whose name starts with the home name', '/home/anabel/notes.db', '/home/anabel/notes.db'],
    ['a path outside the home', '/var/lib/warehouse.db', '/var/lib/warehouse.db'],
  ])('writes %s as the warehouse stores it', (_case, text, stored) => {
    // Act
    const written = withHomeAsTilde(text, HOME)

    // Assert
    expect(written).toBe(stored)
  })
})

describe('adapterEnvironment', () => {
  it("hands the adapters the process's variables, home, working directory and platform", () => {
    // Act
    const env = adapterEnvironment()

    // Assert
    expect(env).toStrictEqual({
      variables: process.env,
      homeDir: homedir(),
      cwd: process.cwd(),
      platform: process.platform === 'darwin' ? 'darwin' : 'linux',
    })
  })
})
