import type { IAdapterEnvironment, IPrompt } from '@log-book/adapter-api'
import type { ISessionCommandRecord, WarehouseStore } from '@log-book/warehouse'
import type { LocatedAdapter } from '../sync/import-step.js'

// An adapter whose prepareCommands threw: its sessions get no rows this sync, and the sync is partial.
export interface ICommandProblem {
  adapter: string
  reason: string
}

interface IPromptRow {
  session_id: string
  message_id: string
  created_at: number
  actor: IPrompt['actor']
  project_dir: string | null
  text: string
}

// Every text part of the user and harness messages of one adapter's sessions: a harness's own record of a typed
// command is one too.
const PROMPTS_READ = `SELECT m.session_id, m.id AS message_id, m.created_at, m.actor, s.project_dir, p.text
  FROM message m
  JOIN session s ON s.id = m.session_id
  JOIN part p ON p.message_id = m.id
  WHERE s.harness = ? AND m.actor IN ('user', 'harness') AND p.kind = 'text'
  ORDER BY m.session_id, m.seq, p.idx`

const commandsOf = async (
  store: WarehouseStore,
  located: LocatedAdapter,
  env: IAdapterEnvironment
): Promise<ISessionCommandRecord[]> => {
  const { id } = located.adapter.descriptor
  const projectDirs = store
    .all<{ project_dir: string }>(
      'SELECT DISTINCT project_dir FROM session WHERE harness = ? AND project_dir IS NOT NULL ORDER BY project_dir',
      id
    )
    .map((row) => row.project_dir)
  const recogniser = await located.adapter.prepareCommands(
    located.kind === 'found' ? located.location : null,
    env,
    projectDirs
  )
  return store.all<IPromptRow>(PROMPTS_READ, id).flatMap((row) => {
    const answer = recogniser.recognise({ actor: row.actor, text: row.text, projectDir: row.project_dir })
    return answer === null
      ? []
      : [
          {
            sessionId: row.session_id,
            messageId: row.message_id,
            at: row.created_at,
            command: answer.command,
            source: answer.source,
            hasFile: answer.hasFile,
          },
        ]
  })
}

// The command pass, after every unit of every adapter is stored. The table is replaced whole, so it runs for every
// adapter with sessions in the warehouse, also one whose data this sync did not find (its location is then null).
export const deriveCommands = async (
  store: WarehouseStore,
  adapters: readonly LocatedAdapter[],
  env: IAdapterEnvironment
): Promise<ICommandProblem[]> => {
  const rows: ISessionCommandRecord[] = []
  const problems: ICommandProblem[] = []
  await adapters.reduce(async (previous, located) => {
    await previous
    const { id } = located.adapter.descriptor
    if (store.get('SELECT 1 FROM session WHERE harness = ? LIMIT 1', id) === undefined) {
      return
    }
    try {
      rows.push(...(await commandsOf(store, located, env)))
    } catch (error: unknown) {
      problems.push({ adapter: id, reason: error instanceof Error ? error.message : String(error) })
    }
  }, Promise.resolve())
  store.replaceSessionCommands(rows)
  return problems
}
