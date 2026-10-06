import { demoCaptureArguments } from './checks/demo-captures.js'
import { dependencyFindings } from './checks/deps.js'
import { fixtureFindings } from './checks/fixtures.js'
import { harnessFindings, ownerFindings } from './checks/literals.js'
import { networkFindings } from './checks/network.js'
import { packageFindings } from './checks/package.js'
import { releaseFindings } from './checks/release.js'
import { checkTests } from './checks/tests.js'
import { stageCli } from './stage/stage-cli.js'
import { stageLibraries } from './stage/stage-libraries.js'

// Where a command writes: findings and refusals go to stderr, one line each.
export interface ICiIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

// A check command: 0 with no finding, 1 with any, 2 on wrong arguments.
type CiCommand = (args: readonly string[], io: ICiIo) => Promise<number>

const WRONG_ARGUMENTS = 2

// A check over the repository in the working directory: each finding on its own line, exit 1 when there is any.
const check =
  (findingsOf: (root: string) => Promise<string[]>): CiCommand =>
  async (args, io) => {
    if (args.length > 0) {
      io.stderr(`This command takes no arguments; got ${args.join(' ')}.\n`)
      return WRONG_ARGUMENTS
    }
    const findings = await findingsOf(process.cwd())
    for (const finding of findings) {
      io.stderr(`${finding}\n`)
    }
    return findings.length === 0 ? 0 : 1
  }

// The two literal checks, by the one option that picks it.
const LITERAL_CHECKS: Readonly<Record<string, (root: string) => Promise<string[]>>> = {
  '--harness': harnessFindings,
  '--owner': ownerFindings,
}

// Every rule CI enforces, by the name its root script passes; each check's ticket adds its command here.
const COMMANDS: Readonly<Record<string, CiCommand>> = {
  'deps': check(dependencyFindings),
  'fixtures': check(fixtureFindings),
  'release': check(releaseFindings),
  'network': check(networkFindings),
  'package': check(packageFindings),
  'literals': async (args, io) => {
    const [option] = args
    const findingsOf = args.length === 1 && option !== undefined ? LITERAL_CHECKS[option] : undefined
    if (findingsOf === undefined) {
      io.stderr(`This command takes --harness or --owner; got ${args.length === 0 ? 'none' : args.join(' ')}.\n`)
      return WRONG_ARGUMENTS
    }
    return check(findingsOf)([], io)
  },
  'tests': async (args, io) => {
    if (args.length > 0) {
      io.stderr(`This command takes no arguments; got ${args.join(' ')}.\n`)
      return WRONG_ARGUMENTS
    }
    return checkTests(process.cwd(), { ...io, env: process.env })
  },
  // Prints `pnpm demo:scan` arguments for each demo entry of the committed capture manifest, for the demo job.
  'demo-captures': async (args, io) => {
    if (args.length > 0) {
      io.stderr(`This command takes no arguments; got ${args.join(' ')}.\n`)
      return WRONG_ARGUMENTS
    }
    const lines = await demoCaptureArguments(process.cwd())
    if (typeof lines === 'string') {
      io.stderr(`${lines}\n`)
      return 1
    }
    for (const line of lines) {
      io.stdout(`${line}\n`)
    }
    return 0
  },
  'stage-cli': async (args, io) => {
    if (args.length > 0) {
      io.stderr(`This command takes no arguments; got ${args.join(' ')}.\n`)
      return WRONG_ARGUMENTS
    }
    await stageCli(process.cwd())
    return 0
  },
  'stage-libraries': async (args, io) => {
    if (args.length > 0) {
      io.stderr(`This command takes no arguments; got ${args.join(' ')}.\n`)
      return WRONG_ARGUMENTS
    }
    await stageLibraries(process.cwd())
    return 0
  },
}

const commandList = (): string => {
  const names = Object.keys(COMMANDS)
  return names.length === 0 ? 'there are none yet' : `the commands are ${names.join(', ')}`
}

// `node packages/ci/dist/index.js <command> [arguments]`.
export const runCi = async (argv: readonly string[], io: ICiIo): Promise<number> => {
  const [name, ...args] = argv
  const command = name === undefined ? undefined : COMMANDS[name]
  if (command === undefined) {
    const given = name === undefined ? 'No command given' : `No command named ${name}`
    io.stderr(`${given}; ${commandList()}.\n`)
    return WRONG_ARGUMENTS
  }
  return command(args, io)
}
