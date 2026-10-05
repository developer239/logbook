#!/usr/bin/env node
// Every planner and writer module must load in UTC, so the zone is set before any of the package's code is imported:
// a static import would be evaluated before this statement.
process.env.TZ = 'UTC'
const { runCommand } = await import('../dist/command.js')
process.exitCode = await runCommand(process.argv.slice(2))
