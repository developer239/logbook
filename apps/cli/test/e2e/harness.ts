import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sealedEnvironment } from '@log-book/demo'
import { afterEach, inject, vi } from 'vitest'

// The binary layer 7 runs: the shim pnpm build stages, or, with LOGBOOK_E2E_BIN set, that file, as CI sets it to the
// logbook installed from the packed tarball. The harness decides which, never a test.
const BUILT_SHIM = fileURLToPath(new URL('../../package/bin/logbook.cjs', import.meta.url))
const BINARY_VARIABLE = 'LOGBOOK_E2E_BIN'
const SEALED_PATH = '/usr/bin:/bin'
const HOST_FILE_SUFFIX = '.host'
const COMMAND_TIMEOUT_MS = 30_000
const HOST_START_TIMEOUT_MS = 30_000
const STOP_GRACE_MS = 5000
const POLL_MS = 50

// What a derived home leaves out of its copy of the demo build's home, relative to the home.
const OPENCODE_DATABASE = '.local/share/opencode/opencode.db'
const CLAUDE_CODE_PROJECTS = '.claude/projects'
// SQLite's write-ahead log beside the warehouse, which holds part of what the build wrote.
const WAL_SUFFIX = '-wal'

// The home a test starts from: a copy of the demo small set's home, or one derived from it, in which discovery finds
// only Claude Code, Claude Code with no transcripts, or no harness.
type TDemoHome = 'demo' | 'one-harness' | 'claude-code-empty' | 'none'

export interface IHomeOptions {
  // `demo` when absent.
  home?: TDemoHome
  // A copy of the build's warehouse beside the home; by default there is none, so the first start is a first run.
  isWarehouseCopied?: boolean
}

// A throwaway home: its directory under the OS temporary directory, and exactly the environment every process run in
// it gets, sealedEnvironment(out).
export interface IE2eHome {
  out: string
  environment: Readonly<Record<string, string>>
}

// The only variables a test may add to the sealed environment.
interface INamedVariables {
  CLAUDE_CONFIG_DIR?: string
  LOGBOOK_HOST_VERSION?: string
}

export interface IRunOptions {
  env?: INamedVariables
  // A directory put first on PATH, for a fake claude.
  firstOnPath?: string
  timeoutMs?: number
}

export interface ICommandResult {
  code: number | null
  stdout: string[]
  stderr: string[]
}

// What the stand-in opener does when logbook calls it: exit with this code, or stay alive until killed.
export type TOpenerBehaviour = { exitCode: 0 | 3 } | 'stay-alive'

interface IOpenerCall {
  name: string
  args: string[]
  pid: number
}

export interface IStandInOpener {
  // Holds the opener as both open and xdg-open, so the same test runs on macOS and Linux.
  directory: string
  calls: () => Promise<IOpenerCall[]>
}

export interface IHostOptions extends IRunOptions {
  // The arguments after `logbook start --port 0`; without the opener, they must hold --no-open.
  args?: readonly string[]
  opener?: IStandInOpener
}

export interface IStartedHost {
  url: string
  pid: number
  output: () => { stdout: string[]; stderr: string[] }
  // Sends SIGINT and resolves with the exit code once the host has exited.
  stop: () => Promise<number | null>
}

interface IHostFile {
  pid: number
  port: number
}

interface IRunning {
  child: ChildProcess
  exited: Promise<unknown>
}

const linesOf = (text: string): string[] => {
  const lines = text.split('\n')
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines
}

const isRunning = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const isInside = (directory: string, path: string): boolean => path.startsWith(`${directory}${sep}`)

// Refuses, before any process starts, a home or warehouse that resolves outside the OS temporary directory, so a test
// can never reach the developer's own warehouse or agent data.
const refuseOutsideTemporary = async (environment: Readonly<Record<string, string>>): Promise<void> => {
  const temporary = await realpath(tmpdir())
  const checked = [
    { name: 'HOME', value: environment.HOME, directory: environment.HOME },
    {
      name: 'LOGBOOK_DB',
      value: environment.LOGBOOK_DB,
      directory: environment.LOGBOOK_DB === undefined ? undefined : dirname(environment.LOGBOOK_DB),
    },
  ]
  const resolved = await Promise.all(
    checked.map(async ({ directory }) =>
      directory === undefined ? undefined : realpath(directory).catch(() => undefined)
    )
  )
  const outside = checked.find((_entry, index) => {
    const path = resolved[index]
    return path === undefined || !isInside(temporary, path)
  })
  if (outside !== undefined) {
    throw new Error(
      `${outside.name} is ${outside.value ?? 'unset'}, outside the OS temporary directory ${temporary}; ` +
        'the end-to-end tests run logbook only in a throwaway home'
    )
  }
}

// The command line of a logbook run: the file LOGBOOK_E2E_BIN names, run directly, or the staged shim run by this Node.
const commandOf = (args: readonly string[]): { file: string; args: string[] } => {
  const binary = process.env[BINARY_VARIABLE]
  if (binary !== undefined && binary !== '') {
    return { file: binary, args: [...args] }
  }
  if (!existsSync(BUILT_SHIM)) {
    throw new Error('the built CLI is missing; run pnpm build')
  }
  return { file: process.execPath, args: [BUILT_SHIM, ...args] }
}

// The sealed environment of the home, the variables the test named, and a directory first on PATH when given.
const environmentOf = (home: IE2eHome, options: IRunOptions): Record<string, string> => {
  const named = Object.fromEntries(
    Object.entries(options.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  const path = home.environment.PATH ?? SEALED_PATH
  return {
    ...home.environment,
    ...named,
    PATH: options.firstOnPath === undefined ? path : `${options.firstOnPath}:${path}`,
  }
}

const readHostFile = async (path: string): Promise<IHostFile> => {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  const { pid, port } = typeof parsed === 'object' && parsed !== null ? (parsed as Partial<IHostFile>) : {}
  if (typeof pid !== 'number' || typeof port !== 'number' || port <= 0 || !isProcessAlive(pid)) {
    throw new Error(`${path} names no live host yet`)
  }
  return { pid, port }
}

// Each placeholder an expected line may hold, and the forms of its value logbook prints.
const PLACEHOLDERS: Readonly<Record<string, string>> = {
  '{duration}': String.raw`(?:\d+\.\d s|\d+ s|\d+ min(?: \d+ s)?|\d+ h(?: \d+ min)?)`,
  '{version}': String.raw`(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`,
  '{port}': String.raw`(?:\d{1,5})`,
  '{size}': String.raw`(?:\d{1,3}(?:,\d{3})* MB|\d+\.\d GB)`,
}
const PLACEHOLDER = /\{(?:duration|version|port|size)\}/gu

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)

const linePattern = (expected: string): RegExp =>
  new RegExp(
    `^${expected
      .split(PLACEHOLDER)
      .map((part, index) => {
        const placeholder = expected.match(PLACEHOLDER)?.[index - 1]
        return `${index === 0 || placeholder === undefined ? '' : (PLACEHOLDERS[placeholder] ?? '')}${escaped(part)}`
      })
      .join('')}$`,
    'u'
  )

// Every line that differs between output and its expected lines, compared exactly but for the placeholders.
export const lineDifferences = (actual: readonly string[], expected: readonly string[]): string[] => {
  const count = Math.max(actual.length, expected.length)
  return Array.from({ length: count }, (_unused, index) => {
    const line = actual[index]
    const wanted = expected[index]
    if (line === undefined || wanted === undefined || !linePattern(wanted).test(line)) {
      return `line ${String(index + 1)}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(line)}`
    }
    return undefined
  }).filter((difference) => difference !== undefined)
}

// The output a child has written so far, as lines.
const collect = (child: ChildProcess): (() => { stdout: string[]; stderr: string[] }) => {
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  return () => ({ stdout: linesOf(stdout), stderr: linesOf(stderr) })
}

// The directory a host start puts first on PATH, refusing a start that would open a real browser: without the stand-in
// opener, its arguments must hold --no-open.
const hostFirstOnPath = (options: IHostOptions, args: readonly string[]): string | undefined => {
  if (options.opener === undefined && !args.includes('--no-open')) {
    throw new Error('a host start opens the browser; pass --no-open or install the stand-in opener')
  }
  if (options.opener !== undefined && options.firstOnPath !== undefined) {
    throw new Error('a host start puts one directory first on PATH: the stand-in opener or the one given')
  }
  return options.opener?.directory ?? options.firstOnPath
}

// The stand-in opener's source: it records its name, arguments and pid, then exits with the chosen code or stays.
const openerSource = (calls: string, behaviour: TOpenerBehaviour): string =>
  [
    `#!${process.execPath}`,
    "const { appendFileSync } = require('node:fs')",
    "const { basename } = require('node:path')",
    `appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ name: basename(process.argv[1]), args: ` +
      "process.argv.slice(2), pid: process.pid }) + '\\n')",
    behaviour === 'stay-alive'
      ? 'setInterval(() => undefined, 60_000)'
      : `process.exitCode = ${String(behaviour.exitCode)}`,
    '',
  ].join('\n')

// Makes the home a test asked for from the build's home: copied, then changed as its variant says.
const fillHome = async (home: string, variant: TDemoHome, buildHome: string): Promise<void> => {
  if (variant === 'none') {
    await mkdir(home)
    return
  }
  await cp(buildHome, home, { recursive: true })
  if (variant === 'one-harness') {
    await rm(join(home, OPENCODE_DATABASE))
  }
  if (variant === 'claude-code-empty') {
    const projects = join(home, CLAUDE_CODE_PROJECTS)
    const entries = await readdir(projects)
    await Promise.all(entries.map(async (entry) => rm(join(projects, entry), { recursive: true })))
  }
}

// Copies the build's warehouse, with its write-ahead log when there is one, to where the home's logbook opens it.
const copyWarehouse = async (warehouse: string, target: string): Promise<void> => {
  await cp(warehouse, target)
  if (existsSync(`${warehouse}${WAL_SUFFIX}`)) {
    await cp(`${warehouse}${WAL_SUFFIX}`, `${target}${WAL_SUFFIX}`)
  }
}

// The harness of layer 7: throwaway homes, logbook runs and hosts in them, and the stand-in opener; at each test's end
// it stops what it started, ends any stand-in opener still alive and removes the homes.
export const useE2eHarness = (): {
  createHome: (options?: IHomeOptions) => Promise<IE2eHome>
  run: (home: IE2eHome, args: readonly string[], options?: IRunOptions) => Promise<ICommandResult>
  startHost: (home: IE2eHome, options?: IHostOptions) => Promise<IStartedHost>
  installOpener: (home: IE2eHome, behaviour: TOpenerBehaviour) => Promise<IStandInOpener>
  teardown: () => Promise<void>
} => {
  const homes: string[] = []
  const running: IRunning[] = []
  const openerCalls: string[] = []

  const spawnLogbook = async (home: IE2eHome, args: readonly string[], options: IRunOptions): Promise<ChildProcess> => {
    const environment = environmentOf(home, options)
    await refuseOutsideTemporary(environment)
    const command = commandOf(args)
    const child = spawn(command.file, command.args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    running.push({ child, exited: once(child, 'exit') })
    return child
  }

  const stopChild = async ({ child, exited }: IRunning): Promise<void> => {
    if (!isRunning(child)) {
      return
    }
    child.kill('SIGTERM')
    const ended = await Promise.race([exited.then(() => true), new Promise((done) => setTimeout(done, STOP_GRACE_MS))])
    if (ended !== true) {
      child.kill('SIGKILL')
      await exited
    }
  }

  const endOpeners = async (): Promise<void> => {
    const calls = await Promise.all(
      openerCalls.map(async (file) => (existsSync(file) ? linesOf(await readFile(file, 'utf8')) : []))
    )
    const pids = calls.flat().map((line) => (JSON.parse(line) as IOpenerCall).pid)
    for (const pid of pids.filter((alive) => isProcessAlive(alive))) {
      process.kill(pid, 'SIGKILL')
    }
    await vi.waitFor(
      () => {
        if (pids.some((pid) => isProcessAlive(pid))) {
          throw new Error('a stand-in opener is still alive')
        }
      },
      { timeout: STOP_GRACE_MS, interval: POLL_MS }
    )
  }

  const teardown = async (): Promise<void> => {
    await Promise.all(running.splice(0).map(async (process) => stopChild(process)))
    await endOpeners()
    openerCalls.splice(0)
    await Promise.all(homes.splice(0).map(async (out) => rm(out, { recursive: true, force: true })))
  }

  afterEach(teardown)

  return {
    createHome: async ({ home = 'demo', isWarehouseCopied = false } = {}) => {
      const out = await mkdtemp(join(await realpath(tmpdir()), 'logbook-e2e-'))
      homes.push(out)
      const environment = sealedEnvironment(out)
      const demo = inject('e2eDemo')
      await fillHome(environment.HOME ?? join(out, 'home'), home, join(demo.out, 'home'))
      if (isWarehouseCopied) {
        await copyWarehouse(demo.warehouse, environment.LOGBOOK_DB ?? join(out, 'warehouse.db'))
      }
      return { out, environment }
    },

    run: async (home, args, options = {}) => {
      const child = await spawnLogbook(home, args, options)
      const output = collect(child)
      const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? COMMAND_TIMEOUT_MS)
      const [code] = (await once(child, 'close')) as [number | null]
      clearTimeout(timeout)
      return { code, ...output() }
    },

    startHost: async (home, options = {}) => {
      const args = options.args ?? []
      const firstOnPath = hostFirstOnPath(options, args)
      const child = await spawnLogbook(home, ['start', '--port', '0', ...args], {
        ...options,
        ...(firstOnPath === undefined ? {} : { firstOnPath }),
      })
      const output = collect(child)
      const hostFile = `${environmentOf(home, options).LOGBOOK_DB ?? ''}${HOST_FILE_SUFFIX}`
      const exited = once(child, 'exit').then(([code]: unknown[]) => {
        throw new Error(
          `logbook start exited with code ${String(code)} before writing its host file: ${output().stderr.join(' ')}`
        )
      })
      const { pid, port } = await Promise.race([
        vi.waitFor(async () => readHostFile(hostFile), { timeout: HOST_START_TIMEOUT_MS, interval: POLL_MS }),
        exited,
      ])
      exited.catch(() => undefined)
      return {
        url: `http://127.0.0.1:${String(port)}`,
        pid,
        output,
        stop: async () => {
          if (isRunning(child)) {
            child.kill('SIGINT')
          }
          const [code] = isRunning(child) ? ((await once(child, 'exit')) as [number | null]) : [child.exitCode]
          return code
        },
      }
    },

    installOpener: async (home, behaviour) => {
      const directory = join(home.out, 'opener')
      const calls = join(home.out, 'opener-calls.jsonl')
      await mkdir(directory, { recursive: true })
      await Promise.all(
        ['open', 'xdg-open'].map(async (name) => {
          await writeFile(join(directory, name), openerSource(calls, behaviour))
          await chmod(join(directory, name), 0o755)
        })
      )
      openerCalls.push(calls)
      return {
        directory,
        calls: async () =>
          existsSync(calls)
            ? linesOf(await readFile(calls, 'utf8')).map((line) => JSON.parse(line) as IOpenerCall)
            : [],
      }
    },

    teardown,
  }
}
