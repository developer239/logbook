import type { IRange } from '../range'
import { modelLabel, REACTIONS, titleOf } from '../sql'
import { all } from '../warehouse'

interface ISaying {
  sessionId: string
  messageId: string
  reaction: string
  quote: string
  at: number
  project: string | null
}

export interface IRule {
  id: string
  text: string
  // Null until the cookbook has judged the group.
  coverage: string | null
  source: string | null
  sayings: ISaying[]
}

export interface IPraise {
  sessionId: string
  messageId: string
  target: string
  quote: string
  at: number
  title: string | null
}

// What a group's coverage says to do first: a rule the instructions contradict, then one they lack.
const COVERAGE_ORDER = ['contradicted', 'missing', 'partly', 'covered']

const urgency = (coverage: string | null): number =>
  coverage === null ? COVERAGE_ORDER.length : COVERAGE_ORDER.indexOf(coverage)

// The groups of rules the cookbook made of the human's reactions, each with the times it was said in the
// range; a group said only outside the range is left out.
export const rules = (range: IRange): IRule[] => {
  const sayings = Map.groupBy(
    all<ISaying & { ruleId: string }>(
      `SELECT g.value AS ruleId, r.session_id AS sessionId, r.message_id AS messageId, r.reaction,
         COALESCE(r.quote, '') AS quote, m.created_at AS at, s.project_dir AS project
       FROM ${REACTIONS} r
       JOIN label g ON g.record_type = 'reaction' AND g.record_id = r.reaction_id AND g.name = 'ruleGroup'
       JOIN message m ON m.id = r.message_id
       JOIN session s ON s.id = r.session_id
       WHERE m.created_at >= ? AND m.created_at < ?
       ORDER BY m.created_at DESC`,
      range.from,
      range.to
    ),
    (saying) => saying.ruleId
  )

  return all<Omit<IRule, 'sayings'>>(
    `SELECT t.record_id AS id, t.value AS text, ${modelLabel('rule', 't.record_id', 'coverage')} AS coverage,
       ${modelLabel('rule', 't.record_id', 'source')} AS source
     FROM label t WHERE t.record_type = 'rule' AND t.name = 'text'`
  )
    .flatMap((rule) => {
      const said = sayings.get(rule.id)
      return said === undefined ? [] : [{ ...rule, sayings: said }]
    })
    .toSorted((left, right) => {
      const byUrgency = urgency(left.coverage) - urgency(right.coverage)

      if (byUrgency !== 0) {
        return byUrgency
      }

      const bySayings = right.sayings.length - left.sayings.length

      return bySayings === 0 ? left.text.localeCompare(right.text) : bySayings
    })
}

export const praise = (range: IRange): IPraise[] =>
  all<IPraise>(
    `SELECT r.session_id AS sessionId, r.message_id AS messageId, r.target, COALESCE(r.quote, '') AS quote,
       m.created_at AS at, ${titleOf('r.session_id')} AS title
     FROM ${REACTIONS} r JOIN message m ON m.id = r.message_id
     WHERE r.reaction = 'praise' AND m.created_at >= ? AND m.created_at < ?
     ORDER BY m.created_at DESC`,
    range.from,
    range.to
  )
