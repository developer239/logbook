import { dependencyFindings } from './checks/deps.js'
import { fixtureFindings } from './checks/fixtures.js'
import { checkTests } from './checks/tests.js'

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

// Every rule CI enforces, by the name its root script passes; each check's ticket adds its command here.
const COMMANDS: Readonly<Record<string, CiCommand>> = {
  deps: check(dependencyFindings),
  fixtures: check(fixtureFindings),
  tests: async (args, io) => {
    if (args.length > 0) {
      io.stderr(`This command takes no arguments; got ${args.join(' ')}.\n`)
      return WRONG_ARGUMENTS
    }
    return checkTests(process.cwd(), { ...io, env: process.env })
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
