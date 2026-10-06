#!/usr/bin/env node
'use strict'

// The logbook binary. CommonJS with nothing newer than ES2017 (so no named capture groups) and no product code, so any
// Node that can start reaches these checks; an ES module graph is linked before its code runs, so a check inside it
// would come too late.
const path = require('path')
const url = require('url')
const manifest = require('../package.json')

const UNSUPPORTED_ENVIRONMENT = 5
const FLOOR = /^>=(\d+)(?:\.(\d+))?$/u

const floor = FLOOR.exec(manifest.engines.node)
const floorMajor = Number(floor[1])
const floorMinor = floor[2] === undefined ? 0 : Number(floor[2])
const floorText = floor[2] === undefined ? floor[1] : `${floor[1]}.${floor[2]}`
const running = process.versions.node.split('.').map(Number)

if (running[0] < floorMajor || (running[0] === floorMajor && running[1] < floorMinor)) {
  process.stderr.write(
    `Log Book needs Node.js ${floorText} or newer; this is Node.js ${process.versions.node} at ${process.execPath}. ` +
      `Install Node.js ${floorText} (https://nodejs.org) or switch to it with your version manager, then run logbook ` +
      'again.\n'
  )
  process.exitCode = UNSUPPORTED_ENVIRONMENT
} else if (process.platform !== 'darwin' && process.platform !== 'linux') {
  process.stderr.write('Log Book runs on macOS and Linux. On Windows, run it inside WSL, where your agents run.\n')
  process.exitCode = UNSUPPORTED_ENVIRONMENT
} else {
  import(url.pathToFileURL(path.join(__dirname, '..', 'dist', 'cli.mjs')).href).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
