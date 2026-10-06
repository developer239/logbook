import { access, mkdir, writeFile } from 'node:fs/promises'
import { COMMANDS, ENVIRONMENT, EXIT_CODES } from '@log-book/cli/grammar'
import { cliPage, commandSlug, environmentPage, exitCodesPage, modelOptionPage, startOptionsPage } from './reference.js'
import { WHAT_TO_DO } from './what-to-do.js'

// The package's src, from dist/scripts where the build leaves this script.
const SOURCE = new URL('../../src/', import.meta.url)
const GENERATED = new URL('.generated/', SOURCE)
const EXAMPLES = new URL('reference/examples/', SOURCE)

// Every command's section includes its written examples, so a command without them stops the generation.
const checkExamples = async (): Promise<void> => {
  const missing = (
    await Promise.all(
      COMMANDS.map(async (command) => {
        const file = new URL(`${commandSlug(command)}.md`, EXAMPLES)
        try {
          await access(file)
          return null
        } catch {
          return file.pathname
        }
      })
    )
  ).filter((file) => file !== null)
  if (missing.length > 0) {
    throw new Error(`No examples for these commands: ${missing.join(', ')}`)
  }
}

// Writes the reference pages' generated parts from the CLI's command table into src/.generated.
const generate = async (): Promise<void> => {
  await checkExamples()
  await mkdir(GENERATED, { recursive: true })
  const files: Readonly<Record<string, string>> = {
    'cli.md': cliPage(COMMANDS, EXIT_CODES),
    'start-options.md': startOptionsPage(COMMANDS),
    'model-option.md': modelOptionPage(COMMANDS),
    'exit-codes.md': exitCodesPage(EXIT_CODES, WHAT_TO_DO),
    'environment.md': environmentPage(ENVIRONMENT),
  }
  await Promise.all(Object.entries(files).map(async ([name, text]) => writeFile(new URL(name, GENERATED), text)))
}

await generate()
