import { countBy, sumBy } from '../lists'
import type { IRange } from '../range'
import { CALL_AT, callAt, retryLoop, titleOf, turnOfCall } from '../sql'
import { all } from '../warehouse'

export interface IRetryLoop {
  sessionId: string
  title: string | null
  name: string
  input: string
  tries: number
  failed: number
  firstCallId: string
  turnId: string | null
  spanMs: number
}

export const retryLoops = (
  range: IRange
): { loops: IRetryLoop[]; tries: number; byTool: { name: string; loops: number }[] } => {
  const loops = all<IRetryLoop>(
    `SELECT x.*, ${turnOfCall('x.firstCallId')} AS turnId FROM (
     SELECT g.session_id AS sessionId, ${titleOf('g.session_id')} AS title, g.bare_name AS name, g.input_json AS input,
       g.tries,
       g.failed, g.last_at - g.first_at AS spanMs,
       (SELECT c2.id FROM tool_call c2 WHERE c2.session_id = g.session_id AND c2.name = g.name
          AND c2.input_json = g.input_json AND ${callAt('c2')} = g.first_at LIMIT 1) AS firstCallId
     FROM (
       SELECT tc.session_id, tc.name, MIN(tc.bare_name) AS bare_name, tc.input_json, COUNT(*) AS tries,
         SUM(tc.status = 'error') AS failed,
         MIN(${CALL_AT}) AS first_at, MAX(${CALL_AT}) AS last_at
       FROM tool_call tc WHERE ${CALL_AT} >= ? AND ${CALL_AT} < ?
       GROUP BY tc.session_id, tc.name, tc.input_json
       HAVING ${retryLoop('tc')}
     ) g) x ORDER BY x.tries DESC, x.failed DESC`,
    range.from,
    range.to
  )

  return {
    loops,
    tries: sumBy(loops, (loop) => loop.tries),
    byTool: [...countBy(loops, (loop) => loop.name)]
      .map(([name, count]) => ({ name, loops: count }))
      .toSorted((left, right) => right.loops - left.loops),
  }
}
