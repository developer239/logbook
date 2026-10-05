import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { IAdapterEnvironment, ICommandRecogniser, IPrompt, IRecognisedCommand } from '@log-book/adapter-api'
import { isErrnoCode } from '@log-book/core'

const CONFIG_DIR_VARIABLE = 'OPENCODE_CONFIG_DIR'
const CONFIG_HOME_VARIABLE = 'XDG_CONFIG_HOME'
const COMMAND_SUFFIX = '.md'
// Enough of a body to tell one command from another, short enough that a later edit further down the file still
// matches older sessions; a shorter body cannot be told from an ordinary prompt.
const TEMPLATE_PREFIX_CHARS = 160
const MIN_TEMPLATE_PREFIX_CHARS = 40
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u
// Where the expansion starts to depend on what was typed: the arguments, a positional argument or a shell output.
const PLACEHOLDER = /\$ARGUMENTS|\$[1-9]|!`/u

interface ITemplate {
  name: string
  prefix: string
}

const collapse = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim()

// OPENCODE_CONFIG_DIR when absolute, else $XDG_CONFIG_HOME/opencode when that is absolute, else ~/.config/opencode;
// a relative value is ignored.
export const resolveConfigDir = (env: IAdapterEnvironment): string => {
  const configured = env.variables[CONFIG_DIR_VARIABLE]
  if (configured !== undefined && isAbsolute(configured)) {
    return configured
  }
  const configHome = env.variables[CONFIG_HOME_VARIABLE]
  return configHome !== undefined && isAbsolute(configHome)
    ? join(configHome, 'opencode')
    : join(env.homeDir, '.config', 'opencode')
}

// A command file's template prefix: its body without front matter, whitespace collapsed, cut at the first placeholder
// and at 160 characters; null when fewer than 40 characters are left.
export const templatePrefix = (content: string): string | null => {
  const body = collapse(content.replace(FRONT_MATTER, ''))
  const cut = PLACEHOLDER.exec(body)
  const prefix = (cut === null ? body : body.slice(0, cut.index)).trimEnd().slice(0, TEMPLATE_PREFIX_CHARS)
  return prefix.length < MIN_TEMPLATE_PREFIX_CHARS ? null : prefix
}

// The template of each `*.md` file directly in a command directory, by name; a missing directory has none.
const templatesIn = async (directory: string): Promise<Map<string, string | null>> => {
  let names: string[]
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith(COMMAND_SUFFIX))
      .map((entry) => entry.name)
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      return new Map()
    }
    throw error
  }
  const templates = await Promise.all(
    names.map(
      async (name) =>
        [name.slice(0, -COMMAND_SUFFIX.length), templatePrefix(await readFile(join(directory, name), 'utf8'))] as const
    )
  )
  return new Map(templates)
}

const withTemplates = (files: ReadonlyMap<string, string | null>): ITemplate[] =>
  [...files].flatMap(([name, prefix]) => (prefix === null ? [] : [{ name, prefix }]))

// The longer prefix wins, then the name that sorts first, so the answer never depends on listing order.
const byPreference = (left: ITemplate, right: ITemplate): number => {
  const longer = right.prefix.length - left.prefix.length
  if (longer !== 0) {
    return longer
  }
  return left.name < right.name ? -1 : Number(left.name > right.name)
}

const recogniseWith =
  (global: ReadonlyMap<string, string | null>, projects: ReadonlyMap<string, ReadonlyMap<string, string | null>>) =>
  (prompt: IPrompt): IRecognisedCommand | null => {
    if (prompt.actor !== 'user') {
      return null
    }
    // A project's file wins over a global one of the same name, for that project's prompts only.
    const project = prompt.projectDir === null ? undefined : projects.get(prompt.projectDir)
    const files = new Map([...global, ...(project ?? [])])
    const text = collapse(prompt.text)
    const [match] = withTemplates(files)
      .filter((template) => text.startsWith(template.prefix))
      .toSorted(byPreference)
    return match === undefined ? null : { command: match.name, source: 'template', hasFile: true }
  }

// OpenCode stores a command's expanded body as the prompt, not its name, so a prompt is recognised by beginning with
// a command file's body. Reads only the `*.md` files of the global command directory and of each project's
// `.opencode/commands/`: never the configuration JSON, AGENTS.md or a skill. The location is not needed.
export const prepareCommands = async (
  env: IAdapterEnvironment,
  projectDirs: readonly string[]
): Promise<ICommandRecogniser> => {
  const global = await templatesIn(join(resolveConfigDir(env), 'commands'))
  const projects = await Promise.all(
    projectDirs.map(async (dir) => [dir, await templatesIn(join(dir, '.opencode', 'commands'))] as const)
  )
  return { recognise: recogniseWith(global, new Map(projects)) }
}
