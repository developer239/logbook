import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { gitWorkspaces } from '../testing/git-workspace.js'
import { promote, type IPromoteContext, type IRegistryAnswer } from './promote.js'

const run = promisify(execFile)
const PACKAGES = ['@log-book/core', '@log-book/cli']
const MIGRATIONS_FILE = 'packages/warehouse/src/migrations.ts'
const BUILT_BY = {
  repository: 'https://github.com/developer239/logbook',
  path: '.github/workflows/ci.yml',
  ref: 'refs/heads/main',
}
const workspaces = gitWorkspaces()
const directories: string[] = []

interface IWorld {
  // The version each package's latest points at.
  latest: string
  // The workflow its provenance names, and the commit it was built from, by version; a version missing has no
  // attestation.
  provenance: Record<string, { workflow: Record<string, string>; commit: string }>
  // The rows of the workflow runs pushed for a commit: name, status and conclusion.
  runs: string[][]
  unfinishedOnMain: number
}

const migrations = (count: number): string =>
  `export const MIGRATIONS: readonly string[] = [\n${Array.from({ length: count }, (_unused, index) => `  \`CREATE TABLE t${String(index)} (a)\`,\n`).join('')}]\n`

const git = async (root: string, ...args: string[]): Promise<string> =>
  (
    await run('git', ['-c', 'user.name=Example', '-c', 'user.email=example@example.com', ...args], { cwd: root })
  ).stdout.trim()

const plant = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  await Promise.all(
    Object.entries(files).map(async ([path, text]) => {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), text)
    })
  )
}

// v1.0.0 from the first pull request, then v1.1.0 from the second, which may add a migration and a quarantined test.
const repository = async (changes: Readonly<Record<string, string>> = {}): Promise<string> => {
  const root = await workspaces.create({
    'packages/ci/src/rules/public-packages.json': JSON.stringify(PACKAGES.map((name) => ({ name }))),
    [MIGRATIONS_FILE]: migrations(1),
  })
  await git(root, 'commit', '-q', '-m', 'feat: [KAN-1] the first change (#1)')
  await git(root, 'tag', 'v1.0.0')
  await plant(root, changes)
  await git(root, 'add', '-A')
  await git(root, 'commit', '-q', '--allow-empty', '-m', 'fix: [KAN-2] the second change (#2)')
  await git(root, 'tag', 'v1.1.0')
  return root
}

const commitOf = async (root: string, version: string): Promise<string> =>
  git(root, 'rev-list', '-n', '1', `v${version}`)

const attestation = (workflow: Record<string, string>, commit: string): unknown => ({
  attestations: [
    { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: {} },
    {
      predicateType: 'https://slsa.dev/provenance/v1',
      bundle: {
        dsseEnvelope: {
          payload: Buffer.from(
            JSON.stringify({
              predicate: {
                buildDefinition: {
                  externalParameters: { workflow },
                  resolvedDependencies: [{ digest: { gitCommit: commit } }],
                },
              },
            })
          ).toString('base64'),
        },
      },
    },
  ],
})

// The registry and GitHub of a world, and every gh call made, in order.
const contextFor = (
  root: string,
  world: IWorld,
  env: Record<string, string> = {}
): { context: IPromoteContext; calls: string[][]; out: string[]; err: string[] } => {
  const calls: string[][] = []
  const [out, err]: [string[], string[]] = [[], []]
  const answerFor = (url: string): IRegistryAnswer => {
    const attested = /attestations\/(?<name>.+)@(?<version>[\d.]+)$/u.exec(url)?.groups
    if (attested !== undefined) {
      const found = world.provenance[attested.version ?? '']
      return found === undefined
        ? { status: 404, body: null }
        : { status: 200, body: attestation(found.workflow, found.commit) }
    }
    if (url.endsWith('/dist-tags')) {
      return { status: 200, body: { latest: world.latest } }
    }
    return { status: 200, body: {} }
  }
  const answerOf = (args: readonly string[]): string => {
    calls.push([...args])
    if (args[0] === 'api') {
      return world.runs.map((row) => row.join('\t')).join('\n')
    }
    if (args.includes('ci.yml')) {
      return String(world.unfinishedOnMain)
    }
    if (args.includes('promote.yml') && args[1] === 'list') {
      return '4242'
    }
    return ''
  }
  return {
    context: {
      root,
      env,
      gh: async (args) => Promise.resolve(answerOf(args)),
      registry: async (url) => Promise.resolve(answerFor(url)),
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    },
    calls,
    out,
    err,
  }
}

// A world where 1.1.0 passes every check: published by ci.yml on main from its tag, every run green, latest 1.0.0.
const passing = async (root: string): Promise<IWorld> => ({
  latest: '1.0.0',
  provenance: {
    '1.0.0': { workflow: BUILT_BY, commit: await commitOf(root, '1.0.0') },
    '1.1.0': { workflow: BUILT_BY, commit: await commitOf(root, '1.1.0') },
  },
  runs: [['CI', 'completed', 'success']],
  unfinishedOnMain: 0,
})

afterEach(async () => {
  await workspaces.removeAll()
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('promote, check 2: published by ci.yml on main', () => {
  it.each([
    ['another workflow', { ...BUILT_BY, path: '.github/workflows/other.yml' }, 'path .github/workflows/other.yml'],
    ['another ref', { ...BUILT_BY, ref: 'refs/heads/feature' }, 'ref refs/heads/feature'],
  ])('refuses a version whose provenance names %s', async (_case, workflow, named) => {
    // Arrange
    const root = await repository()
    const world = await passing(root)
    world.provenance['1.1.0'] = { workflow, commit: await commitOf(root, '1.1.0') }
    const { context, err } = contextFor(root, world)

    // Act
    const code = await promote(['1.1.0', '--dry-run'], context)

    // Assert
    expect({ code, isNamed: err.join('').includes(`provenance names ${named}`) }).toStrictEqual({
      code: 1,
      isNamed: true,
    })
  })

  it('refuses a version with no attestation, like a placeholder', async () => {
    // Arrange
    const root = await repository()
    const world = await passing(root)
    delete world.provenance['1.1.0']
    const { context, err } = contextFor(root, world)

    // Act
    const code = await promote(['1.1.0', '--dry-run'], context)

    // Assert
    expect({ code, err }).toStrictEqual({
      code: 1,
      err: ['@log-book/core@1.1.0 has no provenance, so it was published some other way, such as a placeholder.\n'],
    })
  })
})

describe('promote, check 3: the runs', () => {
  it('refuses a failed run on the tagged commit', async () => {
    // Arrange
    const root = await repository()
    const world = { ...(await passing(root)), runs: [['CI', 'completed', 'failure']] }
    const { context, err } = contextFor(root, world)

    // Act
    const code = await promote(['1.1.0', '--dry-run'], context)

    // Assert
    expect({ code, err }).toStrictEqual({ code: 1, err: ['Not every check of v1.1.0 succeeded: CI failure.\n'] })
  })

  it('refuses while a ci.yml run on main is unfinished', async () => {
    // Arrange
    const root = await repository()
    const world = { ...(await passing(root)), unfinishedOnMain: 1 }
    const { context, err } = contextFor(root, world)

    // Act
    const code = await promote(['1.1.0', '--dry-run'], context)

    // Assert
    expect({ code, err }).toStrictEqual({
      code: 1,
      err: ['A ci.yml run on main is unfinished; promote once it ends, so its verify job sees the move.\n'],
    })
  })
})

describe('promote, check 4: the direction', () => {
  it('refuses a version older than latest without rollback and passes it with rollback', async () => {
    // Arrange
    const root = await repository()
    const world = { ...(await passing(root)), latest: '1.1.0' }

    // Act
    const [plain, rollback] = [contextFor(root, world), contextFor(root, world)]
    const codes = [
      await promote(['1.0.0', '--dry-run'], plain.context),
      await promote(['1.0.0', '--rollback', '--dry-run'], rollback.context),
    ]

    // Assert
    expect({ codes, err: plain.err }).toStrictEqual({
      codes: [1, 0],
      err: ['1.0.0 is not newer than latest, 1.1.0; a rollback sets --rollback.\n'],
    })
  })

  it('refuses a rollback across a warehouse migration', async () => {
    // Arrange
    const root = await repository({ [MIGRATIONS_FILE]: migrations(2) })
    const { context, err } = contextFor(root, { ...(await passing(root)), latest: '1.1.0' })

    // Act
    const code = await promote(['1.0.0', '--rollback', '--dry-run'], context)

    // Assert
    expect({ code, err }).toStrictEqual({
      code: 1,
      err: [
        'Between 1.0.0 and 1.1.0 the warehouse migrated from schema 1 to 2, which 1.0.0 refuses with exit 6. Fix it ' +
          'forward with a fix: release and promote that.\n',
      ],
    })
  })
})

describe('promote, the checklist and the dispatch', () => {
  it("lists the range's pull requests, its migration and a quarantined test with its issue", async () => {
    // Arrange
    const root = await repository({
      [MIGRATIONS_FILE]: migrations(2),
      'packages/core/src/slow.test.ts': [
        "import { it } from 'vitest'",
        '// flaky: https://github.com/developer239/logbook/issues/7',
        "it.skip('waits for the clock', () => {})",
        '',
      ].join('\n'),
    })
    const { context, out, calls } = contextFor(root, await passing(root))

    // Act
    const code = await promote(['1.1.0', '--dry-run'], context)

    // Assert
    expect({ code, checklist: out.join(''), dispatched: calls.filter((call) => call[0] === 'workflow') }).toStrictEqual(
      {
        code: 0,
        checklist: [
          '# Promote 1.1.0 to latest',
          '',
          'latest is 1.0.0 now. Packages: @log-book/core, @log-book/cli.',
          '',
          '## Pull requests since v1.0.0',
          '',
          '- #2 fix: [KAN-2] the second change',
          '',
          '## Warehouse migration',
          '',
          'Schema 1 to 2.',
          '',
          '## Quarantined tests',
          '',
          '- packages/core/src/slow.test.ts: waits for the clock (https://github.com/developer239/logbook/issues/7)',
          '',
          '',
        ].join('\n'),
        dispatched: [],
      }
    )
  })

  it('dispatches promote.yml on main with the version and follows its run when not dry', async () => {
    // Arrange
    const root = await repository()
    const { context, calls } = contextFor(root, await passing(root))

    // Act
    const code = await promote(['1.1.0'], context)

    // Assert
    expect({
      code,
      dispatched: calls.find((call) => call[0] === 'workflow'),
      watched: calls.find((call) => call[1] === 'watch')?.slice(0, 3),
    }).toStrictEqual({
      code: 0,
      dispatched: [
        'workflow',
        'run',
        'promote.yml',
        '--repo',
        'developer239/logbook',
        '--ref',
        'main',
        '-f',
        'version=1.1.0',
        '-f',
        'rollback=false',
      ],
      watched: ['run', 'watch', '4242'],
    })
  })

  it('with --check refuses a run on another ref, and on main writes the outputs and the summary', async () => {
    // Arrange
    const root = await repository()
    const directory = await mkdtemp(join(tmpdir(), 'promote-check-'))
    directories.push(directory)
    const files = { GITHUB_OUTPUT: join(directory, 'output'), GITHUB_STEP_SUMMARY: join(directory, 'summary') }
    await Promise.all(Object.values(files).map(async (file) => writeFile(file, '')))
    const world = await passing(root)
    const branch = contextFor(root, world, {
      ...files,
      VERSION: '1.1.0',
      ROLLBACK: 'false',
      GITHUB_REF: 'refs/heads/x',
    })
    const main = contextFor(root, world, {
      ...files,
      VERSION: '1.1.0',
      ROLLBACK: 'false',
      GITHUB_REF: 'refs/heads/main',
    })

    // Act
    const codes = [await promote(['--check'], branch.context), await promote(['--check'], main.context)]

    // Assert
    expect({
      codes,
      err: branch.err,
      output: await readFile(files.GITHUB_OUTPUT, 'utf8'),
      summary: (await readFile(files.GITHUB_STEP_SUMMARY, 'utf8')).split('\n')[0],
    }).toStrictEqual({
      codes: [1, 0],
      err: ['promote.yml runs from main only; this run is on refs/heads/x.\n'],
      output: 'version=1.1.0\npackages=["@log-book/core","@log-book/cli"]\n',
      summary: '# Promote 1.1.0 to latest',
    })
  })
})
