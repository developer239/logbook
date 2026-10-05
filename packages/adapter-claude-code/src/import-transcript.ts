import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { ADAPTER_ERROR_CODES, compareHarnessVersions, sessionIdOf, type IImportedUnit } from '@log-book/adapter-api'
import { isErrnoCode, LogBookError } from '@log-book/core'
import { listSubagentPaths } from './listing.js'
import { ADAPTER_ID, SessionBuilder, type ISpawnedBy } from './session-builder.js'
import { parseTranscript } from './transcript-lines.js'

const TRANSCRIPT_EXTENSION = '.jsonl'

const readTranscript = async (path: string, locator: string): Promise<string> => {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT')) {
      throw new LogBookError(`The transcript ${path} is gone.`, ADAPTER_ERROR_CODES.ADAPTER_UNIT_GONE, error)
    }
    throw new LogBookError(
      `Cannot read the transcript ${locator}: ${error instanceof Error ? error.message : String(error)}`,
      ADAPTER_ERROR_CODES.ADAPTER_UNIT_UNREADABLE,
      error
    )
  }
}

const SUBAGENT_PREFIX = 'agent-'

const newestVersion = (versions: readonly (string | null)[]): string | null =>
  versions.reduce<string | null>((newest, version) => {
    if (version === null) {
      return newest
    }
    const comparison = newest === null ? 1 : compareHarnessVersions(version, newest)
    return comparison !== null && comparison > 0 ? version : newest
  }, null)

const buildTranscript = async (path: string, locator: string, sourceId: string): Promise<SessionBuilder> => {
  const builder = new SessionBuilder(sessionIdOf(ADAPTER_ID, sourceId))
  for (const entry of parseTranscript(await readTranscript(path, locator))) {
    builder.add(entry)
  }
  return builder
}

interface ISubagent {
  agentId: string
  sourceId: string
  builder: SessionBuilder
}

// The session and call that started each agent, from the results of every transcript of the unit.
const spawnersOf = (builders: readonly SessionBuilder[]): Map<string, { builder: SessionBuilder; callId: string }> =>
  new Map(
    builders.flatMap((builder) =>
      [...builder.spawnedAgents].map(([agentId, callId]) => [agentId, { builder, callId }] as const)
    )
  )

// One unit: the main transcript and each `subagents/agent-<agent id>.jsonl` under `<session id>/`, read whole. Each
// subagent is its own session, `<session id>/agent-<agent id>`, linked to the call whose result reported its agent id
// in whichever transcript holds it, so a nested subagent gets its real parent; one whose call is in no transcript of
// the unit keeps the main session as parent with no call. The unit's harness version is the newest any line records.
export const importTranscript = async (path: string, locator: string): Promise<IImportedUnit> => {
  const sourceId = basename(locator, TRANSCRIPT_EXTENSION)
  const main = await buildTranscript(path, locator, sourceId)
  const subagents: ISubagent[] = await Promise.all(
    (await listSubagentPaths(dirname(path), sourceId)).map(async (subagentPath) => {
      const agentId = basename(subagentPath, TRANSCRIPT_EXTENSION).slice(SUBAGENT_PREFIX.length)
      const subagentSourceId = `${sourceId}/${SUBAGENT_PREFIX}${agentId}`
      return {
        agentId,
        sourceId: subagentSourceId,
        builder: await buildTranscript(subagentPath, locator, subagentSourceId),
      }
    })
  )
  const builders = [main, ...subagents.map((subagent) => subagent.builder)]
  const spawners = spawnersOf(builders)
  const links = new Map<string, ISpawnedBy>()
  for (const [agentId, { builder, callId }] of spawners) {
    const childSessionId = sessionIdOf(ADAPTER_ID, `${sourceId}/${SUBAGENT_PREFIX}${agentId}`)
    links.set(agentId, {
      sessionId: builder.sessionId,
      toolCallId: callId,
      agent: builder.linkChild(callId, childSessionId),
    })
  }
  const sessions = [
    main.build(sourceId),
    ...subagents.map(({ agentId, sourceId: subagentSourceId, builder }) =>
      builder.build(
        subagentSourceId,
        links.get(agentId) ?? { sessionId: main.sessionId, toolCallId: null, agent: null }
      )
    ),
  ]
  const versions = builders.map((builder) => builder.harnessVersion)
  return { sessions, harnessVersion: newestVersion(versions) }
}
