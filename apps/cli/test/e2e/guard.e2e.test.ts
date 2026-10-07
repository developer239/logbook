import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readdir, readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { openSqliteSync } from '@log-book/core'
import { takeSyncLock, type IHeldLock } from '@log-book/warehouse'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { useE2eHarness, type IE2eHome, type IStartedHost } from './harness.js'

// The guard in front of a real host, through the binary: every response goes through it, static files included, and
// no refused POST starts a sync. Requests go through node:http, so Host and Origin are whatever the test sets.
const harness = useE2eHarness()
const run = promisify(execFile)

const HOST_ARGS = ['--no-open', '--no-sync']
const LOGS = '.local/share/log-book/logs'
const FONT = '/fonts/Geist-Variable.woff2'
const EVIL_ORIGIN = 'http://evil.example'
const FORM = 'application/x-www-form-urlencoded'
const HOST_REFUSAL = 'Log Book answers only on 127.0.0.1 and localhost.'
const ORIGIN_REFUSAL = 'Log Book accepts changes only from its own pages.'
const POLICY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; " +
    "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
}

interface IRequest {
  method?: 'GET' | 'POST'
  path: string
  // The Host header; the host's own address when absent.
  host?: string
  origin?: string
  contentType?: string
  body?: string
}

interface IAnswer {
  status: number
  // Every value each header was sent with, by its lower-case name.
  headers: Record<string, string[]>
  body: string
}

// Processes the test keeps alive, so a lock that names one is held by a live process the host did not start.
const holders: ChildProcess[] = []
const locks: IHeldLock[] = []

afterEach(async () => {
  for (const lock of locks.splice(0)) {
    lock.release()
  }
  await Promise.all(
    holders.splice(0).map(async (holder) => {
      const exited = once(holder, 'exit')
      holder.kill()
      await exited
    })
  )
})

const portOf = (host: IStartedHost): number => Number(new URL(host.url).port)
const warehouseOf = (home: IE2eHome): string => home.environment.LOGBOOK_DB ?? ''

const ask = async (host: IStartedHost, { method = 'GET', path, ...sent }: IRequest): Promise<IAnswer> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: sent.host ?? new URL(host.url).host,
      ...(sent.origin === undefined ? {} : { Origin: sent.origin }),
      ...(sent.contentType === undefined ? {} : { 'Content-Type': sent.contentType }),
    }
    const outgoing = request({ host: '127.0.0.1', port: portOf(host), method, path, headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const pairs = response.rawHeaders.flatMap((value, index) =>
          index % 2 === 0 ? [[value.toLowerCase(), response.rawHeaders[index + 1] ?? ''] as const] : []
        )
        resolve({
          status: response.statusCode ?? 0,
          headers: pairs.reduce<Record<string, string[]>>(
            (all, [name, value]) => ({ ...all, [name]: [...(all[name] ?? []), value] }),
            {}
          ),
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    outgoing.on('error', reject)
    outgoing.end(sent.body)
  })

// What a sync leaves: its run record in the warehouse, and the log the host writes.
const syncTraces = async (home: IE2eHome): Promise<{ runs: number; logs: string[] }> => {
  const db = openSqliteSync(warehouseOf(home), { isReadOnly: true })
  try {
    const [row] = db.prepare('SELECT count(*) AS runs FROM sync_run').all() as { runs: number }[]
    const logs = await readdir(join(home.environment.HOME ?? '', LOGS)).catch(() => [])
    return { runs: row?.runs ?? 0, logs: logs.toSorted((left, right) => left.localeCompare(right)) }
  } finally {
    db.close()
  }
}

const newestRun = (home: IE2eHome): { isEnded: number; outcome: string | null } | undefined => {
  const db = openSqliteSync(warehouseOf(home), { isReadOnly: true })
  try {
    const [row] = db
      .prepare('SELECT ended_at IS NOT NULL AS isEnded, outcome FROM sync_run ORDER BY id DESC LIMIT 1')
      .all() as { isEnded: number; outcome: string | null }[]
    return row === undefined ? undefined : { ...row }
  } finally {
    db.close()
  }
}

// The top bar's Sync control as the page renders it.
const syncControl = (page: string): { label: string | undefined; isDisabled: boolean } => {
  const button = /<button[^>]*class="[^"]*top-bar__sync-button[^"]*"[^>]*>[\s\S]*?<\/button>/u.exec(page)?.[0] ?? ''
  return {
    label: /data-sync-label[^>]*>(?<label>[^<]*)</u.exec(button)?.groups?.label,
    isDisabled: /<button[^>]*\sdisabled/u.test(button),
  }
}

// The machine's first non-loopback IPv4 address, if it has one.
const outsideAddress = (): string | undefined =>
  Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .find((address) => address.family === 'IPv4' && !address.internal)?.address

// The test process refuses every connection outside loopback, this machine's own addresses included, so a Node
// process of its own makes the attempt and prints how it ended. A firewall in stealth mode, as macOS can run, drops
// the attempt instead of refusing it, so one that has no answer within its bound ends too.
const NO_ANSWER = 'no answer'
const CONNECT_BOUND_MS = 3000
const CONNECT_SCRIPT = `
const socket = require('node:net').connect({ host: process.argv[1], port: Number(process.argv[2]) })
socket.setTimeout(${String(CONNECT_BOUND_MS)}, () => { console.log('${NO_ANSWER}'); socket.destroy() })
socket.on('connect', () => { console.log('connected'); socket.destroy() })
socket.on('error', (error) => { console.log(error.code ?? error.message) })
`

const connectionOutcome = async (address: string, port: number): Promise<string> =>
  (await run(process.execPath, ['-e', CONNECT_SCRIPT, address, String(port)])).stdout.trim()

const startHost = async (): Promise<{ home: IE2eHome; host: IStartedHost }> => {
  const home = await harness.createHome({ isWarehouseCopied: true })
  return { home, host: await harness.startHost(home, { args: HOST_ARGS }) }
}

describe('the guard in front of a running host', () => {
  it('listens on 127.0.0.1 only: the port takes no connection on the first non-loopback IPv4 address', async ({
    skip,
    annotate,
  }) => {
    // Arrange
    const address = outsideAddress()
    if (address === undefined) {
      skip('this machine has no non-loopback IPv4 address to connect on')
    }
    const { host } = await startHost()

    // Act
    const outcome = await connectionOutcome(address ?? '', portOf(host))
    await annotate(`a connection on the non-loopback address ended: ${outcome}`)

    // Assert
    expect(['ECONNREFUSED', NO_ANSWER]).toContain(outcome)
  })

  it("answers GET / with the policy headers once each and x-log-book naming the host file's version", async () => {
    // Arrange
    const { home, host } = await startHost()
    const { version } = JSON.parse(await readFile(`${warehouseOf(home)}.host`, 'utf8')) as { version: string }

    // Act
    const answer = await ask(host, { path: '/' })

    // Assert
    expect({
      status: answer.status,
      policy: Object.fromEntries(Object.keys(POLICY_HEADERS).map((name) => [name, answer.headers[name]])),
      version: answer.headers['x-log-book'],
    }).toStrictEqual({
      status: 200,
      policy: Object.fromEntries(Object.entries(POLICY_HEADERS).map(([name, value]) => [name, [value]])),
      version: [version],
    })
  })

  it.for(['/', FONT])('refuses GET %s for a rebound Host, with no page content and no x-log-book', async (path) => {
    // Arrange
    const { host } = await startHost()
    const titles = inject('e2eDemo').plan.plan.sessions.flatMap(({ title }) => (title === null ? [] : [title]))

    // Act
    const answer = await ask(host, { path, host: `evil.example:${String(portOf(host))}` })

    // Assert
    expect({
      status: answer.status,
      body: answer.body,
      titles: titles.filter((title) => answer.body.includes(title)),
      version: answer.headers['x-log-book'],
    }).toStrictEqual({ status: 403, body: HOST_REFUSAL, titles: [], version: undefined })
  })

  it.for([
    {
      name: 'a form from another origin',
      sent: { origin: EVIL_ORIGIN, contentType: FORM, body: 'back=%2F' },
      body: ORIGIN_REFUSAL,
    },
    {
      name: 'a Host and an Origin both evil.example',
      sent: { host: 'evil.example:{port}', origin: 'http://evil.example:{port}', contentType: FORM, body: 'back=%2F' },
      body: HOST_REFUSAL,
    },
    {
      name: 'JSON from another origin',
      sent: { origin: EVIL_ORIGIN, contentType: 'application/json', body: '{"back":"/"}' },
      body: ORIGIN_REFUSAL,
    },
    { name: 'a form with no Origin', sent: { contentType: FORM, body: 'back=%2F' }, body: ORIGIN_REFUSAL },
  ])('refuses POST /sync as $name, and no sync runs', async ({ sent, body }) => {
    // Arrange
    const { home, host } = await startHost()
    const port = String(portOf(host))
    const before = await syncTraces(home)

    // Act
    const answer = await ask(host, {
      method: 'POST',
      path: '/sync',
      ...sent,
      ...(sent.host === undefined ? {} : { host: sent.host.replace('{port}', port) }),
      ...(sent.origin === undefined ? {} : { origin: sent.origin.replace('{port}', port) }),
    })

    // Assert
    expect({ status: answer.status, body: answer.body, traces: await syncTraces(home) }).toStrictEqual({
      status: 403,
      body,
      traces: before,
    })
  })

  it('runs a sync for POST /sync from its own origin, and none while a compaction holds the lock', async () => {
    // Arrange
    const { home, host } = await startHost()
    const sync = async (): Promise<IAnswer> =>
      ask(host, { method: 'POST', path: '/sync', origin: host.url, contentType: FORM, body: 'back=%2Fsteps' })
    const before = await syncTraces(home)

    // Act
    const accepted = await sync()
    const afterSync = await syncTraces(home)
    const run = newestRun(home)
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
    holders.push(holder)
    locks.push(takeSyncLock(warehouseOf(home), 'compact', { pid: holder.pid ?? 0 }))
    const duringCompaction = await sync()
    const afterCompaction = await syncTraces(home)
    const page = await ask(host, { path: '/' })

    // Assert
    expect({
      accepted: { status: accepted.status, location: accepted.headers.location },
      added: { runs: afterSync.runs - before.runs, logs: afterSync.logs.length - before.logs.length },
      run,
      duringCompaction: { status: duringCompaction.status, location: duringCompaction.headers.location },
      traces: afterCompaction,
      control: syncControl(page.body),
    }).toStrictEqual({
      accepted: { status: 303, location: ['/steps'] },
      added: { runs: 1, logs: 1 },
      run: { isEnded: 1, outcome: 'ok' },
      duringCompaction: { status: 303, location: ['/steps'] },
      traces: afterSync,
      control: { label: 'Compacting (since 1 min)', isDisabled: true },
    })
  })
})
