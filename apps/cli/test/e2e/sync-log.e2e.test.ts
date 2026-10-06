import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openSqlite } from '@log-book/core'
import { describe, expect, inject, it, vi } from 'vitest'
import { useE2eHarness } from './harness.js'

// A sync log holds counts, paths and error lines, never message text: scanned for every text of the small set that is
// long enough not to occur in a log line by chance.
const harness = useE2eHarness()

const MIN_TEXT_LENGTH = 20
const FIRST_SYNC_DONE = 'First sync   done in '
const FIRST_SYNC_TIMEOUT_MS = 45_000
const POLL_MS = 100
// Every prompt, reply and tool output text the build wrote.
const TEXTS_SQL = `
  SELECT part.text AS text
  FROM part JOIN message ON message.id = part.message_id
  WHERE (part.kind = 'text' AND message.actor IN ('user', 'assistant')) OR part.kind = 'tool_result'`

const textsOfTheSmallSet = async (): Promise<string[]> => {
  const db = await openSqlite(inject('e2eDemo').warehouse, { isReadOnly: true })
  try {
    const rows = db.prepare(TEXTS_SQL).all() as { text: string }[]
    return [...new Set(rows.map(({ text }) => text))].filter((text) => text.length >= MIN_TEXT_LENGTH)
  } finally {
    db.close()
  }
}

describe('the sync log scan', () => {
  it("keeps every message text of the small set out of the host's sync logs", async () => {
    // Arrange
    const home = await harness.createHome()
    const texts = await textsOfTheSmallSet()
    const host = await harness.startHost(home, { args: ['--no-open'] })
    await vi.waitFor(
      () => {
        if (!host.output().stdout.some((line) => line.startsWith(FIRST_SYNC_DONE))) {
          throw new Error(`the first sync has not printed its done line: ${host.output().stdout.join(' | ')}`)
        }
      },
      { timeout: FIRST_SYNC_TIMEOUT_MS, interval: POLL_MS }
    )
    await host.stop()
    const logs = join(home.environment.HOME ?? '', '.local', 'share', 'log-book', 'logs')

    // Act
    const files = await readdir(logs)
    const found = await Promise.all(
      files.map(async (file) => {
        const log = await readFile(join(logs, file), 'utf8')
        const text = texts.find((candidate) => log.includes(candidate))
        return text === undefined ? [] : [`${file} holds ${JSON.stringify(text)}`]
      })
    )

    // Assert
    expect({ hasLogs: files.length > 0, hasTexts: texts.length > 0, found: found.flat() }).toStrictEqual({
      hasLogs: true,
      hasTexts: true,
      found: [],
    })
  })
})
