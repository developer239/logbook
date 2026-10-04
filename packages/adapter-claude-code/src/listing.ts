import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ISourceUnit } from '@log-book/adapter-api'
import { isErrnoCode } from '@log-book/core'

const TRANSCRIPT_EXTENSION = '.jsonl'
const SUBAGENTS_DIRECTORY = 'subagents'

// One unit: a session transcript and every subagent transcript under `<session id>/subagents/`, sorted by name.
export interface ITranscriptSet extends ISourceUnit {
  mainPath: string
  subagentPaths: string[]
}

const byName = (left: string, right: string): number => (left < right ? -1 : Number(left > right))

// The names of the regular files ending .jsonl directly in a directory, sorted; symbolic links are never followed.
const listTranscriptFiles = async (directory: string): Promise<string[]> =>
  (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(TRANSCRIPT_EXTENSION))
    .map((entry) => entry.name)
    .toSorted(byName)

// A directory that is a directory itself, not a symbolic link to one.
const isRealDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await lstat(path)).isDirectory()
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      return false
    }
    throw error
  }
}

// `<size>@<modification time in whole milliseconds>` of each file, joined with `,`: taken from the listing, before
// any content is read.
const fingerprintOf = async (paths: readonly string[]): Promise<string> => {
  const stats = await Promise.all(paths.map((path) => lstat(path)))
  return stats.map((fileStats) => `${String(fileStats.size)}@${String(Math.trunc(fileStats.mtimeMs))}`).join(',')
}

const listSubagentPaths = async (projectDir: string, sessionId: string): Promise<string[]> => {
  const sessionDir = join(projectDir, sessionId)
  const subagentDir = join(sessionDir, SUBAGENTS_DIRECTORY)
  if (!(await isRealDirectory(sessionDir)) || !(await isRealDirectory(subagentDir))) {
    return []
  }
  return (await listTranscriptFiles(subagentDir)).map((name) => join(subagentDir, name))
}

const listProjectSets = async (projects: string, project: string, signal: AbortSignal): Promise<ITranscriptSet[]> => {
  signal.throwIfAborted()
  const projectDir = join(projects, project)
  return Promise.all(
    (await listTranscriptFiles(projectDir)).map(async (fileName) => {
      signal.throwIfAborted()
      const sessionId = fileName.slice(0, -TRANSCRIPT_EXTENSION.length)
      const mainPath = join(projectDir, fileName)
      const subagentPaths = await listSubagentPaths(projectDir, sessionId)
      return {
        locator: `${project}/${fileName}`,
        fingerprint: await fingerprintOf([mainPath, ...subagentPaths]),
        mainPath,
        subagentPaths,
      }
    })
  )
}

// For each directory directly under `projects`, each transcript file directly in it is a session whose id is the file
// name. Reads only entry names and kinds, and each listed transcript's size and modification time; the result is in
// project and file name order.
export const listTranscriptSets = async (projects: string, signal: AbortSignal): Promise<ITranscriptSet[]> => {
  const projectNames = (await readdir(projects, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted(byName)
  const perProject = await Promise.all(projectNames.map((project) => listProjectSets(projects, project, signal)))
  return perProject.flat()
}
