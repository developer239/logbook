import { errorReport, exitCodeOf } from './errors.js'
import { COMMANDS, parseCommandLine, type OptionValue } from './grammar.js'
import { renderCommandHelp, renderHelp } from './help.js'
import { readOwnVersion } from './version.js'

export interface ICliIo {
  argv: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  // Absolute; paths under it are printed with `~`.
  home: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  // Whether stderr is a terminal, where progress lines are redrawn in place.
  isStderrTty: boolean
  // Aborted by SIGINT and SIGTERM.
  signal: AbortSignal
}

interface ICommandContext {
  // The command's words, such as `labels run`.
  command: string
  values: Readonly<Record<string, OptionValue>>
  positionals: readonly string[]
  io: ICliIo
  version: string
}

// Runs one command; resolves to its exit code.
export type CommandRunner = (context: ICommandContext) => Promise<number>

const HOST_VERSION = 'LOGBOOK_HOST_VERSION'
const DEBUG = 'LOGBOOK_DEBUG'

const line = (text: string): string => `${text}\n`

const runCommand = async (runner: CommandRunner, context: ICommandContext, io: ICliIo): Promise<number> => {
  try {
    const code = await runner(context)
    return io.signal.aborted ? exitCodeOf('interrupted') : code
  } catch (error) {
    if (io.signal.aborted) {
      return exitCodeOf('interrupted')
    }
    const report = errorReport(error, { version: context.version, home: io.home, command: context.command })
    if (io.env[DEBUG] === '1' && error instanceof Error && error.stack !== undefined) {
      io.stderr(line(error.stack))
    }
    io.stderr(line(report.line))
    return report.code
  }
}

// One run of logbook: the version check a host's child needs, then the parse, help or version, then the command.
// stdout carries the result; stderr carries progress and, last, the one line of an error.
export const runCli = async (io: ICliIo, runners: Readonly<Record<string, CommandRunner>>): Promise<number> => {
  const version = await readOwnVersion()
  const hostVersion = io.env[HOST_VERSION]
  if (hostVersion !== undefined && hostVersion !== version) {
    io.stderr(line('Log Book was updated while running. Press Ctrl+C and start logbook again.'))
    return exitCodeOf('updated while running')
  }
  const parsed = parseCommandLine(io.argv)
  if (parsed.kind === 'usage-error') {
    io.stderr(line(parsed.line))
    return exitCodeOf('usage error')
  }
  if (parsed.kind === 'version') {
    io.stdout(line(version))
    return exitCodeOf('success')
  }
  if (parsed.kind === 'help') {
    const spec = COMMANDS.find((command) => command.words.join(' ') === parsed.command)
    io.stdout(line(spec === undefined ? renderHelp() : renderCommandHelp(spec)))
    return exitCodeOf('success')
  }
  const runner = runners[parsed.command]
  if (runner === undefined) {
    io.stderr(line(`logbook ${parsed.command} is not in this build yet.`))
    return exitCodeOf('failure')
  }
  const context = { command: parsed.command, values: parsed.values, positionals: parsed.positionals, io, version }
  return runCommand(runner, context, io)
}
