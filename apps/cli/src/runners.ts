import { createDoctorRunner } from './doctor.js'
import { createLabelDropRunner } from './labels-drop.js'
import { createLabelReadRunners } from './labels-read.js'
import { createLabelRunners } from './labels-run.js'
import { createReadRunners } from './read-commands.js'
import { createRewriteRunners } from './rewrite-commands.js'
import type { CommandRunner } from './run-cli.js'
import { createSyncRunner } from './sync.js'

// The commands this build runs, by their words; each command's ticket adds its runner here. A command without one
// fails with a line saying so, never silently.
export const COMMAND_RUNNERS: Readonly<Record<string, CommandRunner>> = {
  'sync': createSyncRunner(),
  ...createReadRunners(),
  ...createLabelRunners(),
  ...createLabelReadRunners(),
  'labels drop': createLabelDropRunner(),
  ...createRewriteRunners(),
  'doctor': createDoctorRunner(),
}
