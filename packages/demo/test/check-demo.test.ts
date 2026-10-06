import { existsSync } from 'node:fs'
import { appendFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqlite } from '@log-book/core'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { checkBuild, checkDemo, type DemoRule } from '../src/check/check-demo.js'
import { DEMO_ERROR_CODES } from '../src/errors.js'

const directories: string[] = []

// A copy of the small set the project's setup built, the warehouse's write-ahead log with it.
const copyOfSmall = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'demo-check-'))
  directories.push(directory)
  const out = join(directory, 'small')
  await cp(inject('smallDemo').out, out, { recursive: true })
  return out
}

const plantInWarehouse = async (out: string, sql: string): Promise<void> => {
  const db = await openSqlite(join(out, 'warehouse.db'), { isReadOnly: false })
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('checkDemo', () => {
  it('passes a clean copy of the small set', async () => {
    // Arrange
    const out = await copyOfSmall()

    // Act
    const findings = await checkDemo(out)

    // Assert
    expect(findings).toStrictEqual([])
  })

  it.each<[string, DemoRule, string, (out: string) => Promise<void>]>([
    [
      'a UUID outside de30da7a in a part text',
      'C5',
      '0f1e2d3c-4b5a-4697-8877-665544332211',
      async (out) =>
        plantInWarehouse(
          out,
          "UPDATE part SET text = text || ' 0f1e2d3c-4b5a-4697-8877-665544332211' WHERE rowid = (SELECT MIN(rowid) FROM part)"
        ),
    ],
    [
      'a ses_ id outside ses_demo<n> in a part text',
      'C5',
      'ses_9xQ2planted',
      async (out) =>
        plantInWarehouse(
          out,
          "UPDATE part SET text = text || ' ses_9xQ2planted' WHERE rowid = (SELECT MIN(rowid) FROM part)"
        ),
    ],
    [
      "the checking machine's home path in a session title",
      'C4',
      homedir(),
      async (out) =>
        plantInWarehouse(out, `UPDATE session SET title = '${homedir().replaceAll("'", "''")}' WHERE rowid = 1`),
    ],
    [
      'an extra file in the demo home',
      'C1',
      'planted secret',
      async (out) => writeFile(join(out, 'home', 'extra.txt'), 'planted secret'),
    ],
    ['plan.json changed after the build', 'C1', 'planted', async (out) => appendFile(join(out, 'plan.json'), ' ')],
    [
      'a session row the manifest does not list',
      'C2',
      'example:planted-session',
      async (out) =>
        plantInWarehouse(
          out,
          `INSERT INTO session (id, harness, source_id, origin, is_scripted) VALUES
             ('example:planted-session', 'example', 'planted-session', 'interactive', 0)`
        ),
    ],
    [
      'a label value outside its vocabulary',
      'C3',
      'planted-goal',
      async (out) =>
        plantInWarehouse(
          out,
          "UPDATE label SET value = 'planted-goal' WHERE name = 'goal' AND labeller <> 'rules' AND record_id = (SELECT MIN(record_id) FROM label WHERE name = 'goal' AND labeller <> 'rules')"
        ),
    ],
  ])('fails %s with its rule, and no finding holds the planted text', async (_name, rule, planted, plant) => {
    // Arrange
    const out = await copyOfSmall()
    await plant(out)

    // Act
    const findings = await checkDemo(out)

    // Assert
    expect({
      rules: [...new Set(findings.map((found) => found.rule))].includes(rule),
      leaks: findings.filter((found) => found.location.includes(planted)),
    }).toStrictEqual({ rules: true, leaks: [] })
  })
})

describe("the build's last step", () => {
  it('removes the warehouse with its write-ahead log and stops with DEMO_CHECK_FAILED, naming the rule', async () => {
    // Arrange
    const out = await copyOfSmall()
    await writeFile(join(out, 'home', 'extra.txt'), 'planted')

    // Act
    const checking = checkBuild(out)

    // Assert
    await expect(checking).rejects.toMatchObject({
      code: DEMO_ERROR_CODES.DEMO_CHECK_FAILED,
      message: 'The demo build breaks C1 at home/extra.txt',
    })
    expect(
      ['warehouse.db', 'warehouse.db-wal', 'warehouse.db-shm'].map((file) => existsSync(join(out, file)))
    ).toStrictEqual([false, false, false])
  })
})
