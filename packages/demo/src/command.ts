const USAGE = 'Usage: logbook-demo <command>'
const EXIT_USAGE = 2

// Every command exits 0 on success, 1 on a failure with its one-line message last on stderr, and 2 on a usage error.
// No command exists yet, so every call is a usage error.
export const runCommand = (args: readonly string[]): Promise<number> => {
  const [command] = args
  process.stderr.write(command === undefined ? `${USAGE}\n` : `Unknown command ${command}. ${USAGE}\n`)
  return Promise.resolve(EXIT_USAGE)
}
