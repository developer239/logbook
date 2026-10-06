import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { LogBookError } from '@log-book/core'
import { isProcessAlive } from '@log-book/warehouse'
import { checkDemo, checkFailure } from '../check/check-demo.js'
import { DEMO_ERROR_CODES } from '../errors.js'
import { BUILT_CLI } from '../import/import-demo.js'
import type { IDemoPlan } from '../plan/types.js'
import { demoWarehousePath, sealedEnvironment } from '../sealed-environment.js'
import { MANIFEST_FILE, PLAN_FILE, type IManifest } from '../write/write-demo.js'

// This module's own location, which the network allowlist test reads, so moving the file without its entry fails.
export const START_DEMO_URL = import.meta.url

export interface IHostOptions {
  // 0 lets the host take any free port.
  port: number
  // Starts with the first sync and its schedule, in place of --no-sync.
  isFresh?: boolean
  // Leaves out --no-open, so logbook opens the page as it opens a user's.
  isOpen?: boolean
}

export interface IStartDemoOptions {
  out: string
  // 0 when absent.
  port?: number
}

export interface IStartedDemo {
  url: string
  // Sends SIGINT and resolves once the host has exited.
  stop: () => Promise<void>
  // As the build wrote them, read after the check proved them its files.
  plan: IDemoPlan
  manifest: IManifest
}

interface IHostFile {
  pid: number
  port: number
}

const POLL_MS = 50

const zoneGuard = (): void => {
  if (process.env.TZ !== 'UTC') {
    throw new LogBookError(
      `the demo starts in UTC; set TZ=UTC (it is ${process.env.TZ ?? 'unset'})`,
      DEMO_ERROR_CODES.DEMO_TZ_NOT_UTC
    )
  }
}

// `logbook start` as a demo host runs it: never syncing on a schedule and never opening a browser unless asked.
const startArgs = ({ port, isFresh = false, isOpen = false }: IHostOptions): string[] => [
  'start',
  ...(isFresh ? [] : ['--no-sync']),
  ...(isOpen ? [] : ['--no-open']),
  '--port',
  String(port),
]

// The built logbook's host in the sealed environment, so it reads only the demo home and its warehouse.
const spawnHost = (out: string, options: IHostOptions, stdio: StdioOptions): ChildProcess => {
  if (!existsSync(BUILT_CLI)) {
    throw new LogBookError('the built CLI is missing; run pnpm build', DEMO_ERROR_CODES.DEMO_CLI_MISSING)
  }
  return spawn(process.execPath, [BUILT_CLI, ...startArgs(options)], { env: sealedEnvironment(out), stdio })
}

// Stops at a finding of the check, naming the first one, before any host starts.
const refuseUnchecked = async (out: string): Promise<void> => {
  const [first] = await checkDemo(out)
  if (first !== undefined) {
    throw checkFailure(first)
  }
}

// Removes the warehouse with its write-ahead log, so the host's first run syncs the demo home from nothing.
export const removeWarehouse = async (out: string): Promise<void> => {
  const warehouse = demoWarehousePath(out)
  await Promise.all(['', '-wal', '-shm'].map(async (suffix) => rm(`${warehouse}${suffix}`, { force: true })))
}

// While the host runs, Ctrl+C is the host's to answer.
const keepRunning = (): void => undefined

// Runs the host with its output passed through until it exits, which Ctrl+C does: the terminal sends SIGINT to the
// host, and this process waits for it. Resolves to the host's exit code.
export const runHost = async (out: string, options: IHostOptions): Promise<number> => {
  process.on('SIGINT', keepRunning)
  try {
    const host = spawnHost(out, options, 'inherit')
    const [code] = (await once(host, 'exit')) as [number | null]
    return code ?? 0
  } finally {
    process.off('SIGINT', keepRunning)
  }
}

const readHostFile = async (path: string): Promise<IHostFile | null> => {
  try {
    const content: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof content === 'object' && content !== null && 'pid' in content && 'port' in content) {
      const { pid, port } = content
      return typeof pid === 'number' && typeof port === 'number' ? { pid, port } : null
    }
    return null
  } catch {
    return null
  }
}

const lastLineOf = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .findLast((line) => line !== '') ?? ''

// Waits until the host file next to the warehouse names a live pid and the bound port, or the host exits first.
const ready = async (host: ChildProcess, warehouse: string, stderr: () => string): Promise<IHostFile> => {
  if (host.exitCode !== null || host.signalCode !== null) {
    throw new LogBookError(
      `logbook start exited before it was ready: ${lastLineOf(stderr())}`,
      DEMO_ERROR_CODES.DEMO_START_FAILED
    )
  }
  const file = await readHostFile(`${warehouse}.host`)
  if (file !== null && file.port > 0 && isProcessAlive(file.pid)) {
    return file
  }
  await sleep(POLL_MS)
  return ready(host, warehouse, stderr)
}

// The library form of `pnpm demo:start --reuse`: it never builds. It checks `out`, then starts the host on it and
// resolves once the host is ready, with its URL, a stop and the build's plan and manifest.
export const startDemo = async ({ out, port = 0 }: IStartDemoOptions): Promise<IStartedDemo> => {
  zoneGuard()
  await refuseUnchecked(out)
  const [plan, manifest] = await Promise.all([
    readFile(join(out, PLAN_FILE), 'utf8').then((text) => JSON.parse(text) as IDemoPlan),
    readFile(join(out, MANIFEST_FILE), 'utf8').then((text) => JSON.parse(text) as IManifest),
  ])
  const host = spawnHost(out, { port }, ['ignore', 'ignore', 'pipe'])
  let stderr = ''
  host.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const exited = once(host, 'exit')
  const file = await ready(host, demoWarehousePath(out), () => stderr)
  return {
    url: `http://127.0.0.1:${String(file.port)}`,
    stop: async () => {
      if (host.exitCode === null && host.signalCode === null) {
        host.kill('SIGINT')
      }
      await exited
    },
    plan,
    manifest,
  }
}
