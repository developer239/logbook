#!/usr/bin/env node
// The demo builds and starts only in UTC, and the zone must be set before any module reads the clock, so this shim
// sets it and only then loads the compiled capture code.
process.env.TZ = 'UTC'
const { runCapture } = await import('../../dist/capture/main.js')
process.exitCode = await runCapture(process.argv.slice(2), (line) => process.stdout.write(line))
