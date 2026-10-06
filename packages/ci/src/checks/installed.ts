import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type IPublicPackage, publicPackagesIn, PUBLISH_ORDER, STAGED } from '../stage/stage-libraries.js'

const run = promisify(execFile)
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
// Every npm call works offline on a cache of its own, so a dependency that would have to be fetched fails the step.
const NPM_FLAGS = ['--offline', '--no-audit', '--no-fund']

// A step that failed, named with its number and what failed in it.
class InstalledFailure extends Error {}

const failure = (step: number, what: string, error: unknown): InstalledFailure => {
  const output = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : ''
  const lines = output.split('\n').filter((line) => line.trim() !== '')
  // The line naming the error, as Node and npm print it; Node's own output ends with its version.
  const reason = lines.find((line) => /error/iu.test(line)) ?? lines.at(-1) ?? String(error)
  return new InstalledFailure(`step ${String(step)}: ${what}: ${reason}`)
}

const npm = async (args: readonly string[], cwd: string, cache: string): Promise<string> =>
  (await run('npm', [...args, '--cache', cache], { cwd, maxBuffer: MAX_OUTPUT_BYTES })).stdout

interface IPacked {
  entry: IPublicPackage
  tarball: string
}

// Step 1: every staged directory of the publish order packed into the directory, in that order.
const packAll = async (
  root: string,
  listed: readonly IPublicPackage[],
  tarballs: string,
  cache: string
): Promise<IPacked[]> => {
  const order = (await readFile(join(root, PUBLISH_ORDER), 'utf8')).split('\n').filter((line) => line !== '')
  return order.reduce<Promise<IPacked[]>>(async (previous, directory) => {
    const packed = await previous
    const entry = listed.find((candidate) => `${candidate.directory}/${STAGED}` === directory)
    if (entry === undefined) {
      throw new InstalledFailure(`step 1: ${directory} is in ${PUBLISH_ORDER} but not in the public package list`)
    }
    const stdout = await npm(['pack', '--pack-destination', tarballs, '--json'], join(root, directory), cache).catch(
      (error: unknown) => {
        throw failure(1, entry.name, error)
      }
    )
    const [result] = JSON.parse(stdout) as { filename: string }[]
    return [...packed, { entry, tarball: join(tarballs, result?.filename ?? '') }]
  }, Promise.resolve([]))
}

// Step 2: the CLI's tarball installed globally into a prefix of its own, offline, and its binary run as a user runs it.
const installCli = async (
  root: string,
  cli: IPacked,
  prefix: string,
  cache: string
): Promise<{ bin: string; version: string }> => {
  await npm(['install', '-g', cli.tarball, '--prefix', prefix, ...NPM_FLAGS], prefix, cache).catch((error: unknown) => {
    throw failure(2, cli.entry.name, error)
  })
  const manifest = JSON.parse(await readFile(join(root, cli.entry.directory, STAGED, 'package.json'), 'utf8')) as {
    version: string
    bin: Record<string, string>
  }
  const [name = ''] = Object.keys(manifest.bin)
  const bin = join(prefix, 'bin', name)
  const { stdout } = await run(bin, ['--version']).catch((error: unknown) => {
    throw failure(2, `${bin} --version`, error)
  })
  const version = stdout.trim()
  if (version !== manifest.version) {
    throw new InstalledFailure(`step 2: ${bin} --version printed ${version}, not the staged ${manifest.version}`)
  }
  return { bin, version }
}

// The specifier a public entry is imported by: the package's name, or its name and the subpath.
const specifierOf = (name: string, subpath: string): string => (subpath === '.' ? name : `${name}/${subpath.slice(2)}`)

// Step 3: the libraries installed together into an empty project, offline, and each public entry imported by name in
// a Node process of its own.
const importLibraries = async (
  libraries: readonly IPacked[],
  project: string,
  cache: string,
  report: (line: string) => void
): Promise<void> => {
  await writeFile(join(project, 'package.json'), `${JSON.stringify({ name: 'installed-check', private: true })}\n`)
  await npm(['install', ...libraries.map(({ tarball }) => tarball), ...NPM_FLAGS], project, cache).catch(
    (error: unknown) => {
      throw failure(3, 'installing the libraries', error)
    }
  )
  const specifiers = libraries.flatMap(({ entry }) =>
    entry.exports.map((subpath) => ({ name: entry.name, specifier: specifierOf(entry.name, subpath) }))
  )
  await specifiers.reduce(async (previous, { name, specifier }) => {
    await previous
    await run(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(specifier)})`], {
      cwd: project,
    }).catch((error: unknown) => {
      throw failure(3, `${name}: ${specifier}`, error)
    })
    report(`Imported ${specifier}`)
  }, Promise.resolve())
}

// Steps 1 to 3 in a directory of their own: packs every staged package, installs the CLI globally and the libraries
// into an empty project, all offline, and returns the installed binary.
export const installPackages = async (
  root: string,
  directory: string,
  report: (line: string) => void
): Promise<string> => {
  const tarballs = join(directory, 'tarballs')
  const prefix = join(directory, 'prefix')
  const project = join(directory, 'project')
  const cache = join(directory, 'cache')
  await Promise.all([tarballs, prefix, project, cache].map(async (path) => mkdir(path)))
  const listed = await publicPackagesIn(root)
  const packed = await packAll(root, listed, tarballs, cache)
  const cli = packed.find(({ entry }) => entry.exports.length === 0)
  if (cli === undefined) {
    throw new InstalledFailure(`step 1: ${PUBLISH_ORDER} names no package without public entries, the CLI`)
  }
  const { bin, version } = await installCli(root, cli, prefix, cache)
  report(`Installed ${cli.entry.name} ${version}: ${bin}`)
  await importLibraries(
    packed.filter((item) => item !== cli),
    project,
    cache,
    report
  )
  return bin
}

// Step 4: the end-to-end suite run against the installed binary, its output shown as it runs.
const runEndToEnd = async (root: string, bin: string, seed: number): Promise<number | null> => {
  const child = spawn('pnpm', ['test:e2e', `--sequence.seed=${String(seed)}`], {
    cwd: root,
    env: { ...process.env, LOGBOOK_E2E_BIN: bin },
    stdio: 'inherit',
  })
  const [code] = (await once(child, 'close')) as [number | null]
  return code
}

const OFFLINE_TEST = 'apps/cli/test/e2e/offline.e2e.test.ts'
const OFFLINE_BUDGET_MS = 60_000
// Run as root inside the new namespace: brings loopback up, then runs the rest of its arguments as the user it is
// given, with the environment it was given.
const NAMESPACE_SCRIPT =
  'ip link set lo up && uid="$1" && gid="$2" && shift 2 && exec setpriv --reuid="$uid" --regid="$gid" --init-groups -- "$@"'

// Step 5, on Linux only: the offline test file again, alone, against the installed binary, inside a new network
// namespace whose only interface is loopback, so its logbook processes really have no network; with
// LOGBOOK_E2E_OFFLINE=1 the test fails when it sees any other interface. The namespace is made with sudo, since
// GitHub's Ubuntu images may restrict unprivileged user namespaces, and the test runs in it as this process's user.
// Resolves with the failure to report, or null.
const runOffline = async (root: string, bin: string, seed: number): Promise<string | null> => {
  const { uid, gid, homedir } = userInfo()
  const child = spawn(
    'sudo',
    [
      '--preserve-env',
      `PATH=${process.env.PATH ?? ''}`,
      `HOME=${homedir}`,
      'unshare',
      '--net',
      '--',
      'sh',
      '-c',
      NAMESPACE_SCRIPT,
      'sh',
      String(uid),
      String(gid),
      'pnpm',
      'test:e2e',
      OFFLINE_TEST,
      `--sequence.seed=${String(seed)}`,
    ],
    {
      cwd: root,
      env: { ...process.env, LOGBOOK_E2E_BIN: bin, LOGBOOK_E2E_OFFLINE: '1' },
      stdio: 'inherit',
      timeout: OFFLINE_BUDGET_MS,
    }
  )
  const [code] = (await once(child, 'close')) as [number | null]
  if (child.killed) {
    return `step 5: the offline run in a network namespace took over ${String(OFFLINE_BUDGET_MS / 1000)} s`
  }
  return code === 0 ? null : `step 5: the offline run in a network namespace exited ${String(code)}`
}

// Steps 4 and 5 against the installed binary; resolves with the failure to report, or null.
const runAgainst = async (
  root: string,
  bin: string,
  seed: number,
  report: (line: string) => void
): Promise<string | null> => {
  const code = await runEndToEnd(root, bin, seed)
  if (code !== 0) {
    return `step 4: the end-to-end run against ${bin} exited ${String(code)}`
  }
  report(`The end-to-end run against ${bin} passed.`)
  if (process.platform !== 'linux') {
    report(`Step 5, the offline run in a network namespace, runs on Linux only; skipped on ${process.platform}.`)
    return null
  }
  const offline = await runOffline(root, bin, seed)
  if (offline === null) {
    report(`The offline run against ${bin} in a network namespace passed.`)
  }
  return offline
}

// `pnpm check:installed --seed <n>`: what users install, not the workspace. Packs every staged package, installs the
// CLI's tarball globally and the libraries into an empty project with no fetch allowed, imports each public entry,
// runs the end-to-end suite against the installed logbook, then, on Linux, its offline test file inside a network
// namespace. The temporary directory goes, also after a failure.
export const checkInstalled = async (
  root: string,
  seed: number,
  io: { stdout: (text: string) => void; stderr: (text: string) => void }
): Promise<number> => {
  const directory = await mkdtemp(join(tmpdir(), 'check-installed-'))
  try {
    const report = (line: string): void => {
      io.stdout(`${line}\n`)
    }
    const bin = await installPackages(root, directory, report)
    const failed = await runAgainst(root, bin, seed, report)
    if (failed !== null) {
      io.stderr(`${failed}\n`)
      return 1
    }
    return 0
  } catch (error) {
    if (error instanceof InstalledFailure) {
      io.stderr(`${error.message}\n`)
      return 1
    }
    throw error
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
