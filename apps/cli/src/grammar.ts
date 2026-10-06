// The command table of logbook: every command, option, default, help text, exit code and environment variable. The
// parser and --help read it, and the documentation site generates its CLI reference from it. Importing it opens no
// file, reads no environment variable and starts no process.
export { ADAPTERS } from './grammar/adapters.js'
export {
  COMMANDS,
  PACKAGE,
  type ICommandSpec,
  type IOptionSpec,
  type IPositionalSpec,
  type OptionKind,
} from './grammar/commands.js'
export { ENVIRONMENT, type IEnvironmentVariable, type IVariableEffect } from './grammar/environment.js'
export { EXIT_CODE_NAMES, EXIT_CODES, type ExitCodeName, type IExitCode } from './grammar/exit-codes.js'
export { commandLineParser, parseCommandLine, type OptionValue, type ParsedCommandLine } from './grammar/parse.js'
