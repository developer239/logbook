import { DIDNT_FINISH } from '../labels'
import type { IRange } from '../range'
import { modelLabel, titleOf } from '../sql'
import { all, get } from '../warehouse'

export interface IUnfinished {
  sessionId: string
  outcome: string
  note: string | null
  title: string | null
  at: number
}

export const unfinished = (range: IRange): { rows: IUnfinished[]; conversationTotal: number } => {
  const rows = all<IUnfinished>(
    `SELECT * FROM (
       SELECT s.id AS sessionId, ${modelLabel('session', 's.id', 'outcome')} AS outcome,
         ${modelLabel('session', 's.id', 'outcomeNote')} AS note, ${titleOf('s.id')} AS title,
         COALESCE(s.ended_at, s.started_at) AS at
       FROM session s WHERE s.started_at >= ? AND s.started_at < ?
     ) WHERE outcome IN (${DIDNT_FINISH.map((outcome) => `'${outcome}'`).join(', ')}) ORDER BY at DESC`,
    range.from,
    range.to
  )

  const conversationTotal =
    get<{ total: number }>(
      'SELECT COUNT(*) AS total FROM session WHERE started_at >= ? AND started_at < ?',
      range.from,
      range.to
    )?.total ?? 0

  return { rows, conversationTotal }
}
