import type { StartedBy } from '../labels'
import { activeMsOf, failedOf, modelLabel, spawnedSessions, startedBy, stepsOf, titleOf } from '../sql'
import { all, get } from '../warehouse'
import { mainModel } from './session'

export interface IConversation {
  id: string
  harness: string
  startedBy: StartedBy
  agent: string | null
  title: string | null
  project: string | null
  branch: string | null
  model: string | null
  startedAt: number | null
  endedAt: number | null
  activeMs: number
  steps: number
  failed: number
  spawned: number
  compactions: number
  goal: string | null
  outcome: string | null
  outcomeNote: string | null
  parent: { sessionId: string; title: string | null; turnId: string } | null
}

export const conversation = (id: string): IConversation | null => {
  const row = get<Omit<IConversation, 'parent'> & { parent: string | null }>(
    `SELECT s.id, s.harness, ${startedBy('s')} AS startedBy, s.agent, ${titleOf('s.id')} AS title,
       s.project_dir AS project, s.started_at AS startedAt, s.ended_at AS endedAt,
       (SELECT m.git_branch FROM message m WHERE m.session_id = s.id AND m.git_branch IS NOT NULL
         ORDER BY m.seq LIMIT 1) AS branch,
       ${mainModel('s.id')} AS model, ${activeMsOf('s')} AS activeMs, ${stepsOf('s')} AS steps,
       ${failedOf('s')} AS failed,
       (SELECT COUNT(*) FROM part p WHERE p.session_id = s.id AND p.kind = 'compaction') AS compactions,
       (SELECT COUNT(*) FROM ${spawnedSessions('s.id')}) AS spawned,
       ${modelLabel('session', 's.id', 'goal')} AS goal, ${modelLabel('session', 's.id', 'outcome')} AS outcome,
       ${modelLabel('session', 's.id', 'outcomeNote')} AS outcomeNote,
       (SELECT json_object('sessionId', p.session_id, 'title', ${titleOf('p.session_id')}, 'turnId', p.message_id)
         FROM turn c JOIN turn p ON p.message_id = c.parent_turn_id WHERE c.session_id = s.id
         ORDER BY c.seq LIMIT 1) AS parent
     FROM session s WHERE s.id = ?`,
    id
  )
  if (row === undefined) {
    return null
  }

  return { ...row, parent: row.parent === null ? null : (JSON.parse(row.parent) as IConversation['parent']) }
}

export const turnPath = (turnId: string): { id: string; sessionId: string }[] =>
  all<{ id: string; sessionId: string }>(
    `WITH RECURSIVE up(id, sessionId, parentId) AS (
       SELECT message_id, session_id, parent_turn_id FROM turn WHERE message_id = ?
       UNION ALL SELECT t.message_id, t.session_id, t.parent_turn_id FROM turn t JOIN up ON t.message_id = up.parentId)
     SELECT id, sessionId FROM up`,
    turnId
  )
