import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ADAPTER_ERROR_CODES } from '@log-book/adapter-api'
import { conformanceCases } from '@log-book/adapter-api/conformance'
import { openSqlite } from '@log-book/core'
import { describe, expect, it } from 'vitest'
import { fixtureSet20, schemaWithout } from '../fixtures/fixture-set.js'
import { openCode } from './adapter.js'

describe('the OpenCode adapter on the conformance suite', () => {
  it.each(conformanceCases(openCode(), [fixtureSet20]).map((testCase) => [testCase.name, testCase]))(
    '%s',
    async (_name, testCase) => {
      // Act
      const run = testCase.run()

      // Assert
      await expect(run).resolves.toBeUndefined()
    }
  )

  it('2.0: refuses a database without session_message.data, naming the table and column', async () => {
    // Arrange
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'log-book-opencode-missing-')))
    try {
      await mkdir(directory, { recursive: true })
      const root = join(directory, 'opencode.db')
      const db = await openSqlite(root, { isReadOnly: false })
      db.exec(schemaWithout('session_message', 'data'))
      db.close()

      // Act
      const opened = openCode().openSource(
        { root, kind: 'file', describe: 'opencode.db' },
        {
          signal: new AbortController().signal,
          onProgress: () => undefined,
          openSqlite,
        }
      )

      // Assert
      await expect(opened).rejects.toMatchObject({
        code: ADAPTER_ERROR_CODES.ADAPTER_FORMAT_UNSUPPORTED,
        message: 'the database has no column session_message.data',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
