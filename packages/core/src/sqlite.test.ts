import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openSqlite, openSqliteSync } from './sqlite.js'

// node:sqlite returns rows as objects without a prototype.
const row = (fields: Record<string, unknown>): Record<string, unknown> =>
  Object.assign(Object.create(null) as Record<string, unknown>, fields)

describe('openSqlite', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'log-book-sqlite-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('creates a file on a read-write open and reads back a written row', async () => {
    // Arrange
    const db = await openSqlite(join(directory, 'example.db'), { isReadOnly: false })

    // Act
    db.exec('CREATE TABLE item (name TEXT NOT NULL)')
    db.prepare('INSERT INTO item (name) VALUES (?)').run('first')
    const rows = db.prepare('SELECT name FROM item').all()
    db.close()

    // Assert
    expect(rows).toStrictEqual([row({ name: 'first' })])
  })

  it('reads through a read-only handle and refuses a write', async () => {
    // Arrange
    const path = join(directory, 'example.db')
    const writer = await openSqlite(path, { isReadOnly: false })
    writer.exec("CREATE TABLE item (name TEXT NOT NULL); INSERT INTO item (name) VALUES ('first')")
    writer.close()

    // Act
    const reader = await openSqlite(path, { isReadOnly: true })
    const rows = reader.prepare('SELECT name FROM item').all()
    const insert = (): void => reader.prepare('INSERT INTO item (name) VALUES (?)').run('second')

    // Assert
    expect(rows).toStrictEqual([row({ name: 'first' })])
    expect(insert).toThrow(/readonly/u)
    reader.close()
  })

  it('sets a busy timeout of 5000 ms on read-write and read-only handles', async () => {
    // Arrange
    const path = join(directory, 'example.db')
    const writer = await openSqlite(path, { isReadOnly: false })
    writer.exec('CREATE TABLE item (name TEXT)')
    const reader = await openSqlite(path, { isReadOnly: true })

    // Act
    const timeouts = [writer.prepare('PRAGMA busy_timeout').get(), reader.prepare('PRAGMA busy_timeout').get()]
    writer.close()
    reader.close()

    // Assert
    expect(timeouts).toStrictEqual([row({ timeout: 5000 }), row({ timeout: 5000 })])
  })

  it('throws when the directory does not exist', async () => {
    // Arrange
    const path = join(directory, 'missing', 'example.db')

    // Act
    const opening = openSqlite(path, { isReadOnly: false })

    // Assert
    await expect(opening).rejects.toThrow(/unable to open database file/u)
  })

  it('opens synchronously the same way, throwing where the async open rejects', () => {
    // Arrange
    const path = join(directory, 'example.db')
    openSqliteSync(path, { isReadOnly: false }).close()

    // Act
    const reader = openSqliteSync(path, { isReadOnly: true })
    const timeout = reader.prepare('PRAGMA busy_timeout').get()
    reader.close()
    const opening = (): unknown => openSqliteSync(join(directory, 'missing', 'example.db'), { isReadOnly: false })

    // Assert
    expect(timeout).toStrictEqual(row({ timeout: 5000 }))
    expect(opening).toThrow(/unable to open database file/u)
  })
})
