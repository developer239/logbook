import { homedir } from 'node:os'
import { runCli } from './run-cli.js'
import { COMMAND_RUNNERS } from './runners.js'

const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    controller.abort()
  })
}

process.exitCode = await runCli(
  {
    argv: process.argv.slice(2),
    env: process.env,
    home: homedir(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    isStderrTty: process.stderr.isTTY,
    signal: controller.signal,
  },
  COMMAND_RUNNERS
)
