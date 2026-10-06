import { runTextChanges } from './text-changes.js'

// pnpm docs:text-changes.
process.exitCode = await runTextChanges(process.argv.slice(2), (text) => process.stdout.write(text))
