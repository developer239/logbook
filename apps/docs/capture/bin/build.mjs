#!/usr/bin/env node
// The capture builds and starts the demo, which runs only in UTC, so the zone is set before any module loads.
process.env.TZ = 'UTC'
const { buildSite } = await import('../../dist/capture/build.js')
process.exitCode = await buildSite(process.argv.slice(2), (line) => process.stdout.write(line))
