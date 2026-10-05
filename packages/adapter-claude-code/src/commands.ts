import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { IAdapterEnvironment, ICommandRecogniser, IPrompt, IRecognisedCommand } from '@log-book/adapter-api'
import { isErrnoCode } from '@log-book/core'
import { resolveConfigDir } from './locate.js'

// Claude Code records a typed command as this tag in the prompt; the name is trimmed and a leading slash is optional.
const COMMAND_NAME = /<command-name>\/?(?<name>[^<]+)<\/command-name>/u
const LEADING_SLASH = /^\//u
const COMMAND_SUFFIX = '.md'

// The names of the `*.md` files directly in a command directory, never their content; a missing directory has none.
const commandNames = async (directory: string): Promise<ReadonlySet<string>> => {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return new Set(
      entries
        .filter((entry) => !entry.isDirectory() && entry.name.endsWith(COMMAND_SUFFIX))
        .map((entry) => entry.name.slice(0, -COMMAND_SUFFIX.length))
    )
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      return new Set()
    }
    throw error
  }
}

const recogniseWith =
  (global: ReadonlySet<string>, projects: ReadonlyMap<string, ReadonlySet<string>>) =>
  (prompt: IPrompt): IRecognisedCommand | null => {
    const command = COMMAND_NAME.exec(prompt.text)?.groups?.name?.trim().replace(LEADING_SLASH, '')
    if (command === undefined || command === '') {
      return null
    }
    const project = prompt.projectDir === null ? undefined : projects.get(prompt.projectDir)
    return { command, source: 'typed', hasFile: global.has(command) || project?.has(command) === true }
  }

// Reads which command files exist: globally in `<configuration directory>/commands/`, and per project in
// `<project>/.claude/commands/`, so a file in one project counts only for that project's sessions. The location is not
// needed: command files live in the configuration directory, not under `projects`. Skills are never read, so a skill
// run as a slash command counts as a command without a file.
export const prepareCommands = async (
  env: IAdapterEnvironment,
  projectDirs: readonly string[]
): Promise<ICommandRecogniser> => {
  const global = await commandNames(join(resolveConfigDir(env), 'commands'))
  const projects = await Promise.all(
    projectDirs.map(async (dir) => [dir, await commandNames(join(dir, '.claude', 'commands'))] as const)
  )
  return { recognise: recogniseWith(global, new Map(projects)) }
}
