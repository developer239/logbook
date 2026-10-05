import { createReadRunners } from './read-commands.js'
import type { CommandRunner } from './run-cli.js'
import { createSyncRunner } from './sync.js'

// The commands this build runs, by their words; each command's ticket adds its runner here. A command without one
// fails with a line saying so, never silently.
export const COMMAND_RUNNERS: Readonly<Record<string, CommandRunner>> = {
  sync: createSyncRunner(),
  ...createReadRunners(),
}
