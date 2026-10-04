import { stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { IAdapterEnvironment, LocateResult } from '@log-book/adapter-api'
import { isErrnoCode } from '@log-book/core'

export const CONFIG_DIR_VARIABLE = 'CLAUDE_CONFIG_DIR'

// The path with the home directory shown as `~`.
const withHomeAsTilde = (path: string, homeDir: string): string => {
  if (path === homeDir) {
    return '~'
  }
  return path.startsWith(`${homeDir}${sep}`) ? `~${path.slice(homeDir.length)}` : path
}

// CLAUDE_CONFIG_DIR when set and not empty (as Claude Code treats an empty value), resolved against the directory
// logbook started in when relative; otherwise ~/.claude.
const resolveConfigDir = (env: IAdapterEnvironment): string => {
  const configured = env.variables[CONFIG_DIR_VARIABLE]
  return configured === undefined || configured === '' ? join(env.homeDir, '.claude') : resolve(env.cwd, configured)
}

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory()
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      return false
    }
    throw error
  }
}

// Claude Code keeps its transcripts under `<configuration directory>/projects`. Only whether that directory exists is
// read here: no file content, nothing else in the configuration directory.
export const locateProjects = async (env: IAdapterEnvironment): Promise<LocateResult> => {
  const projects = join(resolveConfigDir(env), 'projects')
  if (!(await isDirectory(projects))) {
    return { kind: 'not-found', lookedAt: projects }
  }
  return {
    kind: 'found',
    location: { root: projects, kind: 'directory', describe: withHomeAsTilde(projects, env.homeDir) },
  }
}
